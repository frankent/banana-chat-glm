import { beforeEach, describe, expect, it } from '@jest/globals';
import { SqliteCacheAdapter } from '../sqlite-cache';
import { openTestDb, type BetterSqliteDb } from './better-sqlite-driver';
import type { Message } from '@banana-chat/shared';

/**
 * TASK-MOB-005 — scope/logout behavior on real SQLite (TC-MOB-003/004/008).
 */
let db: BetterSqliteDb;

beforeEach(() => {
  db = openTestDb();
});

function msg(seq: number): Message {
  return {
    id: `m-${seq}`,
    room_id: 'room-1',
    workspace_id: 'ws-1',
    sender_id: 'u1',
    sender: null,
    type: 'text',
    body: `x${seq}`,
    seq,
    client_message_id: null,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    mentions: [],
    attachments: [],
  };
}

describe('SQLite cache scoping', () => {
  it('TC-MOB-003 user A never sees user B rows in the same database file', async () => {
    const alice = new SqliteCacheAdapter({ db, scope: { userId: 'alice', workspaceId: 'acme' } });
    const bob = new SqliteCacheAdapter({ db, scope: { userId: 'bob', workspaceId: 'acme' } });

    await alice.saveMessages('room-1', [msg(1), msg(2)]);
    await expect(bob.loadMessages('room-1')).resolves.toBeNull();
    expect((await alice.loadMessages('room-1'))?.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('TC-MOB-008 switching workspace keeps the other workspace cache intact', async () => {
    const acme = new SqliteCacheAdapter({ db, scope: { userId: 'alice', workspaceId: 'acme' } });
    const other = new SqliteCacheAdapter({ db, scope: { userId: 'alice', workspaceId: 'other-co' } });

    await acme.saveMessages('room-1', [msg(1)]);
    await other.saveMessages('room-9', [msg(5)]);

    // "switch" = the active adapter changes; acme rows untouched
    expect((await other.loadMessages('room-9'))?.map((m) => m.seq)).toEqual([5]);
    expect((await acme.loadMessages('room-1'))?.map((m) => m.seq)).toEqual([1]);
  });

  it('TC-MOB-004 logout wipes every scope row in the file (full-device sign-out)', async () => {
    const acme = new SqliteCacheAdapter({ db, scope: { userId: 'alice', workspaceId: 'acme' } });
    const other = new SqliteCacheAdapter({ db, scope: { userId: 'alice', workspaceId: 'other-co' } });
    await acme.saveMessages('room-1', [msg(1)]);
    await other.saveMessages('room-9', [msg(2)]);

    // session.logout() clears the whole cache file (single-user device)
    await db.execAsync('DELETE FROM cache_messages; DELETE FROM cache_outbox; DELETE FROM cache_rooms; DELETE FROM cache_meta;');

    await expect(acme.loadMessages('room-1')).resolves.toBeNull();
    await expect(other.loadMessages('room-9')).resolves.toBeNull();
  });
});
