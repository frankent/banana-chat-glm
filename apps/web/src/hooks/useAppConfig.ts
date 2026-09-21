import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';

/**
 * API-234, FR-ADM-015/DEC-082 — PUBLIC, works pre-auth (login, join/:token).
 * Cached indefinitely: the logo changes rarely, an admin can tell users to
 * refresh, and every caller shares one cached fetch via this query key.
 * Never throws — a branding failure must not block anything it's used on.
 */
export function useAppConfig() {
  return useQuery({
    queryKey: ['app-config'],
    queryFn: () => endpoints.appConfig(),
    staleTime: Infinity,
    retry: 1,
  });
}
