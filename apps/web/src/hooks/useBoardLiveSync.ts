import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type Echo from 'laravel-echo';
import { useEcho } from '../echo/EchoProvider';

/**
 * FR-KAN-007 / B5.7 / EVT-064 — ref-counted `board.changed` listener per
 * (echo, workspace). The first ticket card for a workspace starts listening,
 * the last one to unmount stops the SAME handler. The channel itself is never
 * left (BoardPage and others share it, R7). A change invalidates only the card
 * queries (R6); react-query then refetches the ACTIVE ones once per ticket.
 */
interface Entry { count: number; handler: () => void; channel: ReturnType<Echo<'reverb'>['private']>; timer: ReturnType<typeof setTimeout> | null }

const registry = new WeakMap<object, Map<string, Entry>>();
const DEBOUNCE_MS = 400;

function acquire(echo: Echo<'reverb'>, qc: QueryClient, wid: string, userId: string): () => void {
  let byWs = registry.get(echo);
  if (byWs === undefined) { byWs = new Map(); registry.set(echo, byWs); }
  const k = `${wid}:${userId}`;
  let entry = byWs.get(k);
  if (entry === undefined) {
    const channel = echo.private(`workspace.${wid}`);
    const created: Entry = {
      count: 0,
      channel,
      timer: null,
      handler: () => {
        if (created.timer !== null) clearTimeout(created.timer);
        created.timer = setTimeout(() => {
          created.timer = null;
          void qc.invalidateQueries({ queryKey: ['kanban', wid, userId, 'card'] });
        }, DEBOUNCE_MS);
      },
    };
    channel.listen('.board.changed', created.handler);
    byWs.set(k, created);
    entry = created;
  }
  entry.count += 1;
  const mine = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.count -= 1;
    if (mine.count > 0) return;
    if (mine.timer !== null) clearTimeout(mine.timer);
    mine.channel.stopListening('.board.changed', mine.handler);
    byWs?.delete(k);
  };
}

export function useBoardLiveSync(wid: string | null, userId: string | null): void {
  const { echo } = useEcho();
  const qc = useQueryClient();
  useEffect(() => {
    if (!echo || !wid || !userId) return;
    return acquire(echo, qc, wid, userId);
  }, [echo, qc, wid, userId]);
}
