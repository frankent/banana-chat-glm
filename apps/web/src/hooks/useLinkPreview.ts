import { useQuery } from '@tanstack/react-query';
import { classifyLink } from '@banana-chat/chat-core';
import type { LinkPreview } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';

/** B5.6: re-poll a `pending` preview after 1.5 s, 3 s, 6 s, then give up (plain link). */
export const PENDING_BACKOFF_MS = [1500, 3000, 6000] as const;

export type LinkPreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; preview: Extract<LinkPreview, { status: 'ready' }> }
  | { kind: 'none' };

/** Defence in depth (R9): only classifyLink === external may ever reach the endpoint. */
export function isPreviewableUrl(url: string, appOrigins: readonly string[]): boolean {
  return classifyLink(url, appOrigins)?.kind === 'external';
}

/** Delay before the next poll given how many `pending` answers were already received (1-based), or false = stop. */
export function nextPollDelay(status: LinkPreview['status'] | undefined, pendingCount: number): number | false {
  if (status !== 'pending') return false;
  return PENDING_BACKOFF_MS[pendingCount - 1] ?? false;
}

/** Pure reducer from the query result to what the card shows. Anything but a ready card renders nothing. */
export function previewState(data: LinkPreview | undefined, isError: boolean, enabled: boolean): LinkPreviewState {
  if (!enabled) return { kind: 'idle' };
  if (isError) return { kind: 'none' };
  if (data === undefined) return { kind: 'loading' };
  if (data.status === 'ready') {
    return data.title || data.description || data.site_name ? { kind: 'ready', preview: data } : { kind: 'none' };
  }
  return data.status === 'pending' ? { kind: 'loading' } : { kind: 'none' };
}

/** Freshness: a ready preview is re-fetched once its signed image URL has expired. */
export function previewStaleTime(data: LinkPreview | undefined, now = Date.now()): number {
  if (data === undefined || data.status === 'pending') return 0;
  if (data.status !== 'ready') return 60_000;
  const exp = data.image_expires_at === null ? NaN : Date.parse(data.image_expires_at);
  return Number.isFinite(exp) ? Math.max(0, exp - now - 30_000) : 5 * 60_000;
}

export function useLinkPreview(url: string, visible: boolean): LinkPreviewState {
  const meId = useSession((s) => s.me?.id ?? null);
  const slug = useSession((s) => s.currentWorkspace?.workspace.slug ?? null);
  const wsId = useSession((s) => s.currentWorkspace?.workspace.id ?? null);
  const origins = typeof window === 'undefined' ? [] : [window.location.origin];
  const enabled = visible && meId !== null && slug !== null && wsId !== null && isPreviewableUrl(url, origins);

  const query = useQuery({
    queryKey: ['link-preview', meId, wsId, url],
    queryFn: () => endpoints.linkPreview(slug as string, url),
    enabled,
    retry: false,
    staleTime: (q) => previewStaleTime(q.state.data),
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => nextPollDelay(q.state.data?.status, q.state.dataUpdateCount),
  });
  return previewState(query.data, query.isError, enabled);
}
