import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@banana-chat/api-client';
import { deadlineState, ticketKey } from '@banana-chat/chat-core';
import { endpoints } from '../../lib/api';
import { useChatText } from '../../lib/use-chat-text';
import { useSession } from '../../state/session';
import { useBoardLiveSync } from '../../hooks/useBoardLiveSync';

/** Viewport tracking: `seen` is sticky (first hydration), `inView` is live (polling). */
function useInView<T extends Element>(): [React.RefObject<T | null>, boolean, boolean] {
  const ref = useRef<T | null>(null);
  const supported = typeof IntersectionObserver !== 'undefined';
  const [inView, setInView] = useState(!supported);
  const [seen, setSeen] = useState(!supported);
  useEffect(() => {
    const el = ref.current;
    if (!supported || el === null) return;
    const io = new IntersectionObserver(entries => {
      const hit = entries.some(e => e.isIntersecting);
      setInView(hit);
      if (hit) setSeen(true);
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [supported]);
  return [ref, inView, seen];
}

const PRIORITY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

/**
 * FR-KAN-007 / B5.4 — live ticket card. Workspace comes ONLY from the link's
 * `ws` (else the current workspace); an unknown slug never fires a request (R4).
 * 403/404/unknown ws all render the identical "unavailable" state.
 */
export function TicketLinkCard({ ticketId, ws, href }: { ticketId: string; ws: string | null; href: string }) {
  const { text, locale } = useChatText();
  const me = useSession(s => s.me);
  const workspaces = useSession(s => s.workspaces);
  const current = useSession(s => s.currentWorkspace);
  const slug = ws ?? current?.workspace.slug ?? null;
  const target = slug === null ? undefined : workspaces.find(w => w.workspace.slug === slug);
  const wid = target?.workspace.id ?? null;
  const [ref, inView, seen] = useInView<HTMLDivElement>();
  useBoardLiveSync(seen ? wid : null, me?.id ?? null);

  const query = useQuery({
    queryKey: ['kanban', wid, me?.id, 'card', ticketId],
    queryFn: () => endpoints.ticketCard(slug!, ticketId),
    enabled: wid !== null && me !== null && seen,
    staleTime: 15_000,
    retry: (count, err) => !(err instanceof ApiError && [401, 403, 404].includes(err.status)) && count < 1,
    refetchInterval: inView ? 30_000 : false,
    refetchOnWindowFocus: true,
  });

  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  const unavailable = wid === null || denied || (query.isError && query.data === undefined);
  const card = unavailable ? undefined : query.data;
  const stale = card !== undefined && (query.isError || (typeof navigator !== 'undefined' && navigator.onLine === false));
  const state = unavailable ? 'unavailable' : card === undefined ? 'loading' : stale ? 'stale' : 'ready';
  const label = text('chat.ticketUnavailable');

  if (state === 'unavailable') {
    return (
      <div ref={ref} className="bc-linkcard bc-linkcard-muted" data-testid="ticket-link-card" data-state="unavailable" role="group" aria-label={label}>
        <span className="bc-linkcard-title">{label}</span>
      </div>
    );
  }
  if (card === undefined) {
    return (
      <div ref={ref} className="bc-linkcard bc-linkcard-skeleton" data-testid="ticket-link-card" data-state="loading" role="group" aria-busy="true" aria-label={text('chat.ticketCardLoading')}>
        <span className="bc-linkcard-bar" /><span className="bc-linkcard-bar short" />
      </div>
    );
  }

  const key = ticketKey(slug!, card.number);
  const due = card.due_at !== null ? deadlineState(card.due_at, card.lane.is_done) : 'none';
  const dueText = card.due_at !== null
    ? text('chat.ticketDue').replace('{time}', new Date(card.due_at).toLocaleDateString(locale, { day: 'numeric', month: 'short' }))
    : null;
  const foreign = ws !== null && current !== null && ws !== current.workspace.slug;
  return (
    <div ref={ref} className="bc-linkcard" data-testid="ticket-link-card" data-state={state} data-lane-done={card.lane.is_done ? 'true' : 'false'}>
      <Link to={`/board/${card.id}?ws=${encodeURIComponent(slug!)}`} className="bc-linkcard-main" data-testid="ticket-link-card-open" title={href}>
        <span className="bc-linkcard-head">
          <span className="bc-linkcard-key" data-testid="ticket-link-card-key">{key}</span>
          <span className="bc-linkcard-lane" data-testid="ticket-link-card-lane" data-done={card.lane.is_done ? 'true' : 'false'} style={{ ['--lane' as string]: card.lane.color }}>{card.lane.name}</span>
        </span>
        <span className="bc-linkcard-title" data-testid="ticket-link-card-title">{card.title}</span>
        <span className="bc-linkcard-meta">
          <span data-testid="ticket-link-card-priority" data-priority={card.priority}>{PRIORITY[card.priority] ?? card.priority}</span>
          <span data-testid="ticket-link-card-assignee">{card.assignee?.display_name ?? text('chat.ticketUnassigned')}</span>
          {dueText !== null && <span data-testid="ticket-link-card-due" data-due={due}>{dueText}</span>}
        </span>
        {foreign && target !== undefined && <span className="bc-linkcard-meta">{text('chat.ticketWorkspace').replace('{name}', target.workspace.name)}</span>}
      </Link>
      {stale && <span className="bc-linkcard-stale" role="status" data-testid="ticket-link-card-stale">{text('chat.ticketStale')}</span>}
    </div>
  );
}
