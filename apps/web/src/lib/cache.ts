import { DexieAiCacheAdapter, DexieCacheAdapter } from '@banana-chat/chat-core/dexie';
import type { AiCacheAdapter, CacheAdapter, CacheScope } from '@banana-chat/chat-core';

/**
 * TASK-WEB-016 (FR-OFF-001 web) — IndexedDB cache singletons, scoped per
 * (user, workspace). Rooms + newest 50 messages/room hydrate the UI before
 * the network answers; logout wipes every opened adapter (TC-CORE-021).
 */
const DB_NAME = 'banana-chat';
const roomCaches = new Map<string, CacheAdapter>();
const aiCaches = new Map<string, AiCacheAdapter>();

export function roomCache(scope: CacheScope): CacheAdapter {
  const key = `${scope.userId}:${scope.workspaceId}`;
  let cache = roomCaches.get(key);
  if (cache === undefined) {
    cache = new DexieCacheAdapter({ scope, messageLimit: 50, dbName: DB_NAME });
    roomCaches.set(key, cache);
  }
  return cache;
}

export function aiCache(userId: string): AiCacheAdapter {
  let cache = aiCaches.get(userId);
  if (cache === undefined) {
    cache = new DexieAiCacheAdapter({ userId, messageLimit: 100, dbName: DB_NAME });
    aiCaches.set(userId, cache);
  }
  return cache;
}

/** TC-CORE-021 — logout clears rooms, messages, AI cache and the outbox. */
export async function clearAllCaches(): Promise<void> {
  await Promise.all([...roomCaches.values(), ...aiCaches.values()].map((cache) => cache.clearAll()));
  roomCaches.clear();
  aiCaches.clear();
}
