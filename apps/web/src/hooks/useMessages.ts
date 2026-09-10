import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { roomCache } from '../lib/cache';
import { roomStore } from '../lib/room-stores';
import { useSession } from '../state/session';

/** FR-MSG-009/FR-OFF-001: never reseed a live store with a React Query snapshot. */
export function useMessagePage(roomId: string | undefined, slug: string | undefined, aroundSeq?: number) {
  const { me, currentWorkspace } = useSession();
  const scope = me && currentWorkspace ? { userId: me.id, workspaceId: currentWorkspace.workspace.id } : null;
  const store = roomId ? roomStore(roomId) : null;
  const fetched = useRef(false);
  const query = useQuery({
    queryKey: ['messages', roomId, me?.id, currentWorkspace?.workspace.id, aroundSeq ?? 'latest'],
    queryFn: async () => {
      const page = await endpoints.messages(roomId!, slug!, aroundSeq !== undefined ? { around_seq: aroundSeq } : {});
      fetched.current = true;
      store!.mergePage(page.messages);
      if (scope) await roomCache(scope).saveMessages(roomId!, store!.getState().messages);
      return page;
    },
    enabled: !!roomId && !!slug && !!scope,
    staleTime: 0,
    gcTime: 5 * 60_000,
  });
  useEffect(() => {
    let cancelled = false;
    fetched.current = false;
    if (roomId && scope && store?.getState().messages.length === 0) {
      void roomCache(scope).loadMessages(roomId).then(cached => {
        if (!cancelled && !fetched.current && cached && store.getState().messages.length === 0) store.mergePage(cached);
      });
    }
    return () => { cancelled = true; };
  }, [store, roomId, me?.id, currentWorkspace?.workspace.id]);
  const loadOlder = useCallback(async () => {
    const oldest = store?.getState().messages[0]?.seq;
    if (!roomId || !slug || !store || oldest === undefined || oldest <= 1) return false;
    const page = await endpoints.messages(roomId, slug, { before_seq: oldest, limit: 50 });
    store.add(page.messages);
    return page.has_more_before;
  }, [roomId, slug, store]);
  const fillGap = useCallback(async (afterSeq: number, beforeSeq: number) => {
    if (!roomId || !slug || !store) return;
    const page = await endpoints.messages(roomId, slug, { after_seq: afterSeq, limit: Math.min(100, beforeSeq - afterSeq - 1) });
    store.fillDelivered(page.messages);
  }, [roomId, slug, store]);
  return { query, loadOlder, fillGap };
}
