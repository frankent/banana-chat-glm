import { describe, expect, it } from 'vitest';
import type { Message } from '@banana-chat/shared';
import { MessageStore } from '../src/index.js';
import { MemoryAiCacheAdapter } from '../src/ai-cache.js';
import { MemoryCacheAdapter } from '../src/cache.js';
import { runAiCacheAdapterContractTests, runCacheAdapterContractTests } from '../src/cache.contract.js';

const SCOPE = { userId: 'user-1', workspaceId: 'ws-1' };

runCacheAdapterContractTests(
  'MemoryCacheAdapter',
  (opts) =>
    new MemoryCacheAdapter({
      scope: opts?.scope ?? SCOPE,
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
      backing: opts?.backing as Map<string, unknown> | undefined,
    }),
  () => new Map<string, unknown>(),
);

runAiCacheAdapterContractTests(
  'MemoryAiCacheAdapter',
  (opts) =>
    new MemoryAiCacheAdapter({
      userId: opts?.userId ?? 'user-1',
      messageLimit: opts?.messageLimit,
      schemaVersion: opts?.schemaVersion,
      backing: opts?.backing as Map<string, unknown> | undefined,
    }),
  () => new Map<string, unknown>(),
);

/** TC-CORE-023 — cache hydrate → sync prepends rows above the head. */
describe('MessageStore prependCount', () => {
  it('reports rows prepended above the previous head', () => {
    const store = new MessageStore('room-1');
    // hydrate from cache: tail window 10..12
    store.replace([msg(10), msg(11), msg(12)]);

    // server sync fills older pages 1..9
    const state = store.add([msg(1), msg(2), msg(3), msg(4), msg(5), msg(6), msg(7), msg(8), msg(9)]);
    expect(state.prependCount).toBe(9);
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('appending newer rows reports zero prepends', () => {
    const store = new MessageStore('room-1');
    store.replace([msg(1), msg(2)]);
    expect(store.add(msg(3)).prependCount).toBe(0);
  });

  it('replace and gap-timeout reset the counter', () => {
    const store = new MessageStore('room-1', 10);
    store.add([msg(1), msg(5)]); // seeds + gap withholding
    store.add([msg(2), msg(3)]);
    expect(store.getState().prependCount).toBe(2);

    store.replace([msg(1)]);
    expect(store.getState().prependCount).toBe(0);
  });

  it('fillDelivered also reports prepends', () => {
    const store = new MessageStore('room-1', 10);
    store.add([msg(1), msg(5)]);
    store.fillDelivered([msg(2), msg(3), msg(4)]);
    expect(store.getState().prependCount).toBe(3);
  });
});

function msg(seq: number): Message {
  return {
    id: `m-${seq}`,
    room_id: 'room-1',
    workspace_id: 'ws-1',
    sender_id: 'u-1',
    sender: null,
    type: 'text',
    body: `message ${seq}`,
    seq,
    client_message_id: null,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    mentions: [],
    attachments: [],
  };
}
