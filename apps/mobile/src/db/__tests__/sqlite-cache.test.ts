import { afterEach, beforeEach, expect } from '@jest/globals';
import { CACHE_SCHEMA_VERSION } from '@banana-chat/chat-core';
import { runAiCacheAdapterContractTests, runCacheAdapterContractTests } from '@banana-chat/chat-core/contract';
import { SqliteAiCacheAdapter, SqliteCacheAdapter } from '../sqlite-cache';
import { migrateDb, SQLITE_USER_VERSION } from '../schema';
import { openTestDb, type BetterSqliteDb } from './better-sqlite-driver';

/**
 * TASK-MOB-005 — the SQLite adapter runs the SAME contract suite as the web
 * Dexie adapter (TC-MOB-002) over real SQL via better-sqlite3, plus the
 * SQLite-specific migration test (TC-MOB-005).
 */
let db: BetterSqliteDb;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

runCacheAdapterContractTests(
  'SqliteCacheAdapter',
  (opts) =>
    new SqliteCacheAdapter({
      db,
      scope: opts?.scope ?? { userId: 'user-1', workspaceId: 'ws-1' },
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
    }),
  () => db,
);

runAiCacheAdapterContractTests(
  'SqliteAiCacheAdapter',
  (opts) =>
    new SqliteAiCacheAdapter({
      db,
      userId: opts?.userId ?? 'user-1',
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
    }),
  () => db,
);

describe('SQLite-specific behavior', () => {
  it('TC-MOB-005 migrateDb stamps PRAGMA user_version and is idempotent', async () => {
    const row0 = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row0?.user_version ?? 0).toBe(0);

    await migrateDb(db);
    const row1 = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row1?.user_version).toBe(SQLITE_USER_VERSION);

    await migrateDb(db); // re-run is a no-op
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cache_%'");
    expect(tables.map((t) => t.name).sort()).toEqual(['cache_messages', 'cache_meta', 'cache_outbox', 'cache_rooms']);
  });

  it('TC-MOB-005 a future schema version wipes stale rows but keeps the db usable', async () => {
    const adapter = new SqliteCacheAdapter({ db, scope: { userId: 'u', workspaceId: 'w' } });
    await adapter.saveRooms([
      {
        room: { id: 'r1', workspace_id: 'w', type: 'channel', name: 'r', description: null, avatar_attachment_id: null, created_by: 'u', last_seq: 1, member_count: 1, last_message_at: null },
        my_role: 'member',
        other_user: null,
        last_message: null,
        unread_count: 0,
        muted: false,
      },
    ]);
    expect(await adapter.loadRooms()).not.toBeNull();

    const upgraded = new SqliteCacheAdapter({ db, scope: { userId: 'u', workspaceId: 'w' }, schemaVersion: CACHE_SCHEMA_VERSION + 1 });
    await expect(upgraded.loadRooms()).resolves.toBeNull();
    await upgraded.saveRooms([]);
    await expect(upgraded.loadRooms()).resolves.toEqual([]); // usable after wipe
  });
});
