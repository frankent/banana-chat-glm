/**
 * TASK-CORE-005 — backoff helper for SyncEngine-lite / reconnect loops.
 */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = baseMs * 2 ** Math.min(attempt, 6);
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, maxMs);
}

export interface SyncPlan {
  /** resume from this seq on the next /messages call */
  afterSeq: number;
  /** rooms whose last_seq moved while we were away */
  changedRoomIds: string[];
}

/**
 * Diff a cached room list against the server list (SyncEngine-lite, FR-WS-005):
 * returns the rooms whose last_seq advanced so the UI can fetch just those.
 */
export function planSync(
  cached: { room: { id: string; last_seq: number } }[],
  server: { room: { id: string; last_seq: number } }[],
): SyncPlan {
  const known = new Map(cached.map((entry) => [entry.room.id, entry.room.last_seq]));
  const changedRoomIds: string[] = [];
  let afterSeq = 0;

  for (const entry of server) {
    const before = known.get(entry.room.id);
    if (before === undefined || entry.room.last_seq > before) {
      changedRoomIds.push(entry.room.id);
    }
  }

  return { afterSeq, changedRoomIds };
}
