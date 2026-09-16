import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { filterExpiredRooms, nextSecretDeadline } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';
import { roomCache } from '../lib/cache';
import { evictRoom } from '../lib/room-eviction';
import { useSession } from '../state/session';

/**
 * TASK-WEB-016 — rooms hydrate from the IndexedDB cache first, then the
 * network refresh replaces them. Only the canonical 'all' list is persisted.
 */
export function useRooms(slug: string | undefined, filter: 'all' | 'unread' = 'all') {
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  const workspace = useSession((s) => s.currentWorkspace);
  const scope = me !== null && workspace !== null ? { userId: me.id, workspaceId: workspace.workspace.id } : null;

  const query = useQuery({
    queryKey: ['rooms', slug, filter],
    queryFn: async () => {
      const rooms = await endpoints.rooms(slug!, filter);
      if (filter === 'all' && scope !== null) {
        void roomCache(scope).saveRooms(rooms);
      }
      return rooms;
    },
    enabled: slug !== undefined,
    staleTime: 10_000,
    retry: 2,
  });

  // instant paint from cache while the request is in flight
  useEffect(() => {
    if (slug === undefined || filter !== 'all' || scope === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = await roomCache(scope).loadRooms();
      if (cancelled || cached === null || queryClient.getQueryData(['rooms', slug, 'all']) !== undefined) {
        return;
      }
      // FR-ROOM-012 (offline) — the cache may hold a secret room past its
      // deadline (asleep/offline, no EVT): filter it BEFORE painting and
      // purge its local content in the same pass
      const { live, expiredRoomIds } = filterExpiredRooms(cached);
      for (const expiredId of expiredRoomIds) {
        void evictRoom(scope, expiredId);
      }
      queryClient.setQueryData(['rooms', slug, 'all'], live);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, filter, me?.id, workspace?.workspace.id]);

  // FR-ROOM-012 (offline) — bounded deadline watch while the tab is open:
  // one timer at the earliest live expiry (re-armed at most daily), plus a
  // re-check whenever the tab becomes visible again (covers sleeps).
  useEffect(() => {
    const rooms = query.data;
    if (scope === null || rooms === undefined) {
      return;
    }
    const sweep = () => {
      const { expiredRoomIds } = filterExpiredRooms(rooms);
      for (const expiredId of expiredRoomIds) {
        void evictRoom(scope, expiredId);
      }
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    };
    if (filterExpiredRooms(rooms).expiredRoomIds.length > 0) {
      sweep();
      return;
    }
    const deadline = nextSecretDeadline(rooms);
    const wait = deadline === null
      ? 24 * 3_600_000
      : Math.min(Math.max(deadline - Date.now() + 500, 1_000), 24 * 3_600_000);
    const timer = setTimeout(sweep, wait);
    const onWake = () => sweep();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('pageshow', onWake);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('pageshow', onWake);
    };
  }, [query.data, scope?.userId, scope?.workspaceId, queryClient]);

  return query;
}

export function useDirectory(slug: string | undefined, q = '') {
  return useQuery({
    queryKey: ['directory', slug, q],
    queryFn: () => endpoints.directory(q, slug!),
    enabled: slug !== undefined,
    staleTime: 30_000,
  });
}

export function useInvalidateRooms() {
  const queryClient = useQueryClient();
  return (slug: string) =>
    queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
}
