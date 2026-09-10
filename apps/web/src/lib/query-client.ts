import { QueryClient } from '@tanstack/react-query';
import { registerSessionCleanup } from './session-resources';
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } },
});
registerSessionCleanup(async () => {
  await queryClient.cancelQueries();
  queryClient.clear();
});
