import { forgetChatPosition } from '../hooks/useChatScroll';
import type { CacheScope } from '@banana-chat/chat-core';
import { roomCache } from './cache';
import { queryClient } from './query-client';
import { disposeRoomStore } from './room-stores';
import { sessionOutbox } from './outbox';

/**
 * FR-ROOM-012 / FR-ROOM-008 — a room that vanished server-side (deleted by
 * its owner, or a secret room that expired) must leave EVERY local layer:
 *
 *  1. IndexedDB (messages, rooms-list row, queued outbox bodies/drafts)
 *  2. the in-memory MessageStore for that room
 *  3. the live outbox queue
 *  4. React Query caches (messages, room detail, members, read-status, pins)
 *
 * An eviction marker guards stale in-flight requests: a message page that
 * resolves after the eviction must not re-persist secret content into the
 * cache or the store.
 */

const evictedRooms = new Set<string>();

function evictionKey(scope: CacheScope, roomId: string): string {
  return `${scope.userId}:${scope.workspaceId}:${roomId}`;
}

/** True once the room was evicted in this session — skip re-persisting it. */
export function isRoomEvicted(scope: CacheScope, roomId: string): boolean {
  return evictedRooms.has(evictionKey(scope, roomId));
}

export async function evictRoom(scope: CacheScope, roomId: string): Promise<void> {
  evictedRooms.add(evictionKey(scope, roomId));
  forgetChatPosition(evictionKey(scope, roomId));

  // 1. durable cache — messages + rooms-list row + outbox drafts
  try {
    await roomCache(scope).deleteRoom?.(roomId);
  } catch {
    // best-effort: the next saveRooms overwrite also drops the row
  }

  // 2. in-memory message store for the room
  disposeRoomStore(scope, roomId);

  // 3. live outbox — queued bodies would only 410 on send anyway
  try {
    await sessionOutbox().outbox.removeRoom(roomId);
  } catch {
    // session not bootstrapped — the cache purge above already dropped the
    // persisted drafts, and restore() only loads what still exists
  }

  // 4. React Query content for the room (prefix keys; pins keys are
  //    [pins, slug, roomId, me] so match by predicate)
  queryClient.removeQueries({ queryKey: ['messages', roomId] });
  queryClient.removeQueries({ queryKey: ['room', roomId] });
  queryClient.removeQueries({ queryKey: ['room-members', roomId] });
  queryClient.removeQueries({ queryKey: ['read-status', roomId] });
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] === 'pins' && q.queryKey[2] === roomId });
  void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
}
