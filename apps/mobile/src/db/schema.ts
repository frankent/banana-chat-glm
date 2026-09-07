import type { MobileSqliteDatabase } from './driver';

/**
 * TASK-MOB-005 — SQLite schema + migrations (TC-MOB-005). PRAGMA user_version
 * drives forward migrations; the app-level cache schema version (cache_meta)
 * handles "newer data than this build understands" by wiping.
 */
export const SQLITE_USER_VERSION = 1;

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS cache_rooms (
  scope TEXT PRIMARY KEY,
  rooms TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_messages (
  scope TEXT NOT NULL,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (scope, room_id, seq)
);
CREATE TABLE IF NOT EXISTS cache_outbox (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  order_n INTEGER NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (scope, id)
);
CREATE TABLE IF NOT EXISTS ai_conversations (
  user_id TEXT PRIMARY KEY,
  list TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_messages (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  PRIMARY KEY (user_id, conversation_id, seq)
);
CREATE TABLE IF NOT EXISTS cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** idempotent; bumps PRAGMA user_version after applying pending steps */
export async function migrateDb(db: MobileSqliteDatabase): Promise<void> {
  await db.execAsync(V1_SCHEMA);
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) < SQLITE_USER_VERSION) {
    await db.execAsync(`PRAGMA user_version = ${SQLITE_USER_VERSION}`);
  }
}
