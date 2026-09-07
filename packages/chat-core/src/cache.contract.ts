import { describe, expect, it } from 'vitest';
import type { AiConversationSummary, AiMessage, Message, RoomListItem } from '@banana-chat/shared';
import { CACHE_SCHEMA_VERSION, type CacheAdapter, type CacheScope, type OutboxEntry } from './cache.js';
import type { AiCacheAdapter } from './ai-cache.js';

/**
 * TASK-CORE-007 / TASK-CORE-010 — adapter contract tests. Run the same suite
 * against every CacheAdapter implementation (Memory, Dexie, mobile SQLite).
 */

export interface CacheContractOptions {
  scope?: CacheScope;
  messageLimit?: number;
  schemaVersion?: number;
  /** the backing store shared between adapter instances (version test) */
  backing?: unknown;
}

function msg(seq: number, roomId = 'room-1'): Message {
  return {
    id: `m-${seq}`,
    room_id: roomId,
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
    created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    mentions: [],
    attachments: [],
  };
}

function roomItem(id: string): RoomListItem {
  return {
    room: {
      id,
      workspace_id: 'ws-1',
      type: 'channel',
      name: `room ${id}`,
      description: null,
      avatar_attachment_id: null,
      created_by: 'u-1',
      last_seq: 1,
      member_count: 2,
      last_message_at: null,
    },
    my_role: 'member',
    other_user: null,
    last_message: null,
    unread_count: 0,
    muted: false,
  };
}

function outboxEntry(order: number): OutboxEntry {
  return {
    id: `ob-${order}`,
    order,
    status: 'pending',
    room_id: 'room-1',
    workspace_id: 'ws-1',
    client_message_id: `cmid-${order}`,
    body: 'queued while offline',
    attachments: [],
    attempts: 0,
    last_error: null,
    created_local_at: new Date(2026, 0, 1, 0, 0, order).toISOString(),
  };
}

function aiMsg(seq: number, conversationId = 'conv-1'): AiMessage {
  return {
    id: `ai-${seq}`,
    conversation_id: conversationId,
    seq,
    role: 'user',
    status: 'completed',
    content: `ai ${seq}`,
    client_message_id: null,
    parent_message_id: null,
    model: null,
    finish_reason: null,
    tokens_prompt: null,
    tokens_completion: null,
    error_code: null,
    created_at: null,
    completed_at: null,
  };
}

function aiConv(id: string): AiConversationSummary {
  return {
    id,
    title: `conversation ${id}`,
    title_source: 'user',
    message_count: 2,
    last_message_at: null,
    archived_at: null,
    generating: false,
  };
}

export function runCacheAdapterContractTests(
  name: string,
  make: (opts?: CacheContractOptions) => CacheAdapter | Promise<CacheAdapter>,
  freshBacking?: () => unknown,
): void {
  describe(`${name} — CacheAdapter contract`, () => {
    it('TC-CORE-020 saves and loads rooms + messages per (user, workspace)', async () => {
      const adapter = await make();
      await adapter.saveRooms([roomItem('r1'), roomItem('r2')]);
      await adapter.saveMessages('room-1', [msg(1), msg(2), msg(3)]);

      await expect(adapter.loadRooms()).resolves.toHaveLength(2);
      const messages = await adapter.loadMessages('room-1');
      expect(messages?.map((m) => m.seq)).toEqual([1, 2, 3]);

      // another scope sees nothing
      const other = await make({ scope: { userId: 'user-2', workspaceId: 'ws-1' } });
      await expect(other.loadRooms()).resolves.toBeNull();
      await expect(other.loadMessages('room-1')).resolves.toBeNull();
    });

    it('TC-CORE-022 keeps only the newest messageLimit rows per room (LRU)', async () => {
      const adapter = await make({ messageLimit: 3 });
      await adapter.saveMessages('room-1', [msg(1), msg(2), msg(3), msg(4), msg(5)]);
      const loaded = await adapter.loadMessages('room-1');
      expect(loaded?.map((m) => m.seq)).toEqual([3, 4, 5]);

      // a later smaller snapshot replaces the room, not merges with it
      await adapter.saveMessages('room-1', [msg(8), msg(9)]);
      expect((await adapter.loadMessages('room-1'))?.map((m) => m.seq)).toEqual([8, 9]);
    });

    it('TC-CORE-021 clearAll wipes rooms, messages and outbox', async () => {
      const adapter = await make();
      await adapter.saveRooms([roomItem('r1')]);
      await adapter.saveMessages('room-1', [msg(1)]);
      await adapter.saveOutbox([outboxEntry(1)]);

      await adapter.clearAll();

      await expect(adapter.loadRooms()).resolves.toBeNull();
      await expect(adapter.loadMessages('room-1')).resolves.toBeNull();
      await expect(adapter.loadOutbox()).resolves.toBeNull();
    });

    it('TC-CORE-032 persists outbox entries through the adapter', async () => {
      const adapter = await make();
      await adapter.saveOutbox([outboxEntry(1), outboxEntry(2)]);
      const loaded = await adapter.loadOutbox();
      expect(loaded?.map((e) => e.client_message_id)).toEqual(['cmid-1', 'cmid-2']);
      expect(loaded?.[0]?.status).toBe('pending');
    });

    it('returns null when nothing was written', async () => {
      const adapter = await make();
      await expect(adapter.loadRooms()).resolves.toBeNull();
      await expect(adapter.loadMessages('room-x')).resolves.toBeNull();
      await expect(adapter.loadOutbox()).resolves.toBeNull();
    });

    (freshBacking === undefined ? it.skip : it)('TC-CORE-024 schema version mismatch wipes the cache', async () => {
      const backing = freshBacking!();
      const adapter = await make({ backing });
      await adapter.saveRooms([roomItem('r1')]);
      await adapter.saveMessages('room-1', [msg(1), msg(2)]);
      expect(await adapter.loadRooms()).not.toBeNull();

      // same backing opened by an adapter expecting a newer schema
      const upgraded = await make({ backing, schemaVersion: CACHE_SCHEMA_VERSION + 1 });
      await expect(upgraded.loadRooms()).resolves.toBeNull();
      await expect(upgraded.loadMessages('room-1')).resolves.toBeNull();
    });
  });
}

export function runAiCacheAdapterContractTests(
  name: string,
  make: (opts?: { userId?: string; messageLimit?: number; schemaVersion?: number; backing?: unknown }) =>
    | AiCacheAdapter
    | Promise<AiCacheAdapter>,
  freshBacking?: () => unknown,
): void {
  describe(`${name} — AiCacheAdapter contract`, () => {
    it('TC-CORE-050 saves and loads the conversation list + newest messages', async () => {
      const adapter = await make({ messageLimit: 3 });
      await adapter.saveConversations([aiConv('c1'), aiConv('c2')]);
      await adapter.saveMessages('conv-1', [aiMsg(1), aiMsg(2), aiMsg(3), aiMsg(4), aiMsg(5)]);

      await expect(adapter.loadConversations()).resolves.toHaveLength(2);
      const messages = await adapter.loadMessages('conv-1');
      expect(messages?.map((m) => m.seq)).toEqual([3, 4, 5]);

      // user-scoped: another user sees nothing
      const other = await make({ userId: 'user-2' });
      await expect(other.loadConversations()).resolves.toBeNull();
      await expect(other.loadMessages('conv-1')).resolves.toBeNull();
    });

    it('TC-CORE-050 clearAll empties list + messages', async () => {
      const adapter = await make();
      await adapter.saveConversations([aiConv('c1')]);
      await adapter.saveMessages('conv-1', [aiMsg(1)]);

      await adapter.clearAll();

      await expect(adapter.loadConversations()).resolves.toBeNull();
      await expect(adapter.loadMessages('conv-1')).resolves.toBeNull();
    });

    (freshBacking === undefined ? it.skip : it)('TC-CORE-024 schema version mismatch wipes the cache', async () => {
      const backing = freshBacking!();
      const adapter = await make({ backing });
      await adapter.saveConversations([aiConv('c1')]);
      const upgraded = await make({ backing, schemaVersion: CACHE_SCHEMA_VERSION + 1 });
      await expect(upgraded.loadConversations()).resolves.toBeNull();
    });
  });
}
