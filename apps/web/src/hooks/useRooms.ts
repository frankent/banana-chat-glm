import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api';

export function useRooms(slug: string | undefined, filter: 'all' | 'unread' = 'all') {
  return useQuery({
    queryKey: ['rooms', slug, filter],
    queryFn: () => endpoints.rooms(slug!, filter),
    enabled: slug !== undefined,
    staleTime: 10_000,
  });
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
