import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { roomCache } from '../lib/cache';
import { useSession } from '../state/session';

/**
 * TASK-WEB-016 — rooms hydrate from the IndexedDB cache first, then the
 * network refresh replaces them. Only the canonical 'all' list is persisted.
 */
export function useRooms(slug: string | undefined, filter: 'all' | 'unread' = 'all') {
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  const workspace = useSession((s) => s.currentWorkspace);

  const query = useQuery({
    queryKey: ['rooms', slug, filter],
    queryFn: async () => {
      const rooms = await endpoints.rooms(slug!, filter);
      if (filter === 'all' && me !== null && workspace !== null) {
        void roomCache({ userId: me.id, workspaceId: workspace.workspace.id }).saveRooms(rooms);
      }
      return rooms;
    },
    enabled: slug !== undefined,
    staleTime: 10_000,
  });

  // instant paint from cache while the request is in flight
  useEffect(() => {
    if (slug === undefined || filter !== 'all' || me === null || workspace === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = await roomCache({ userId: me.id, workspaceId: workspace.workspace.id }).loadRooms();
      if (!cancelled && cached !== null && queryClient.getQueryData(['rooms', slug, 'all']) === undefined) {
        queryClient.setQueryData(['rooms', slug, 'all'], cached);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, filter, me?.id, workspace?.workspace.id]);

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
