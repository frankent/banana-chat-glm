/** FR-AUTH-003/FR-OFF-001: invalidate in-memory owners before another login. */
const cleanups = new Set<() => void | Promise<void>>();
export function registerSessionCleanup(cleanup: () => void | Promise<void>) {
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
}
export async function resetSessionResources() {
  await Promise.all([...cleanups].map(cleanup => cleanup()));
}
