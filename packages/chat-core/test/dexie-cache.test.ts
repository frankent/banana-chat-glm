import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { DexieAiCacheAdapter, DexieCacheAdapter } from '../src/dexie-cache.js';
import { runAiCacheAdapterContractTests, runCacheAdapterContractTests } from '../src/cache.contract.js';

/**
 * TASK-WEB-016 — the Dexie adapter passes the same contract suite
 * (TC-CORE-020..024, TC-CORE-050) under fake-indexeddb.
 */
const dbNames: string[] = [];
let counter = 0;

function freshDbName(): string {
  const name = `banana-chat-test-${Date.now()}-${counter++}`;
  dbNames.push(name);
  return name;
}

afterAll(async () => {
  await Promise.all(dbNames.map((name) => new DexieCacheAdapter({ scope: { userId: 'x', workspaceId: 'y' }, dbName: name }).delete()));
});

runCacheAdapterContractTests(
  'DexieCacheAdapter',
  (opts) =>
    new DexieCacheAdapter({
      scope: opts?.scope ?? { userId: 'user-1', workspaceId: 'ws-1' },
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
      dbName: typeof opts?.backing === 'string' ? opts.backing : freshDbName(),
    }),
  freshDbName,
);

runAiCacheAdapterContractTests(
  'DexieAiCacheAdapter',
  (opts) =>
    new DexieAiCacheAdapter({
      userId: opts?.userId ?? 'user-1',
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
      dbName: typeof opts?.backing === 'string' ? opts.backing : freshDbName(),
    }),
  freshDbName,
);

describe('DexieCacheAdapter scope isolation in a shared DB', () => {
  it('two workspaces of the same user do not see each other', async () => {
    const dbName = freshDbName();
    const ws1 = new DexieCacheAdapter({ scope: { userId: 'u', workspaceId: 'ws-1' }, dbName });
    const ws2 = new DexieCacheAdapter({ scope: { userId: 'u', workspaceId: 'ws-2' }, dbName });

    await ws1.saveMessages('room-1', [{ ...baseMsg(1), seq: 1 }]);

    await expect(ws2.loadMessages('room-1')).resolves.toBeNull();
    await expect(ws1.loadMessages('room-1')).resolves.not.toBeNull();
  });
});

function baseMsg(seq: number) {
  return {
    id: `m-${seq}`,
    room_id: 'room-1',
    workspace_id: 'ws-1',
    sender_id: 'u-1',
    sender: null,
    type: 'text' as const,
    body: 'x',
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
