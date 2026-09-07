import Dexie from 'dexie';
import type { Dexie as DexieInstance, Table } from 'dexie';
import type { AiConversationSummary, AiMessage, Message, RoomListItem } from '@banana-chat/shared';
import { CACHE_SCHEMA_VERSION, SchemaVersionGuard, scopeKey, type CacheAdapter, type CacheScope, type OutboxEntry } from './cache.js';
import type { AiCacheAdapter } from './ai-cache.js';

/**
 * TASK-WEB-016 — IndexedDB cache via Dexie. Exported from the './dexie'
 * subpath so mobile (SQLite adapter) never pulls the dexie dependency.
 */

interface RoomsRow {
  k: string;
  rooms: RoomListItem[];
}
interface MessageRow {
  k: string;
  room: string;
  seq: number;
  message: Message;
}
interface OutboxRow {
  k: string;
  order: number;
  entry: OutboxEntry;
}
interface AiConvRow {
  k: string;
  list: AiConversationSummary[];
}
interface AiMessageRow {
  k: string;
  conversation: string;
  seq: number;
  message: AiMessage;
}
interface MetaRow {
  k: string;
  version: number;
}

interface CacheDb extends DexieInstance {
  rooms: Table<RoomsRow, string>;
  messages: Table<MessageRow, string>;
  outbox: Table<OutboxRow, string>;
  aiConversations: Table<AiConvRow, string>;
  aiMessages: Table<AiMessageRow, string>;
  meta: Table<MetaRow, string>;
}

/**
 * The bundled d.ts ships the default export as a type-only namespace merge,
 * so the class construct signature is asserted once here (NodeNext picks it
 * up; bundler consumers type it natively).
 */
const DexieCtor = Dexie as unknown as new (name: string) => DexieInstance;

function openDb(dbName: string): CacheDb {
  const db = new DexieCtor(dbName) as CacheDb;
  // camelCase store names — Dexie exposes tables as same-named properties
  db.version(1).stores({
    rooms: 'k',
    messages: 'k, room, seq',
    outbox: 'k, order',
    aiConversations: 'k',
    aiMessages: 'k, conversation, seq',
    meta: 'k',
  });
  return db;
}

export interface DexieCacheOptions {
  scope: CacheScope;
  messageLimit?: number;
  schemaVersion?: number;
  dbName?: string;
}

/** one row per message → partial writes, cheap LRU trim by seq */
export class DexieCacheAdapter implements CacheAdapter {
  private readonly db: CacheDb;
  private readonly scope: string;
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;

  constructor(opts: DexieCacheOptions) {
    this.db = openDb(opts.dbName ?? 'banana-chat-cache');
    this.scope = scopeKey(opts.scope);
    this.messageLimit = opts.messageLimit ?? 50; // FR-OFF-001 web: newest 50/room
    const versionKey = `${this.scope}@version`;
    this.guard = new SchemaVersionGuard(
      async () => (await this.db.meta.get(versionKey))?.version ?? null,
      async (v) => {
        await this.db.meta.put({ k: versionKey, version: v });
      },
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  async saveRooms(rooms: RoomListItem[]): Promise<void> {
    await this.guard.check();
    await this.db.rooms.put({ k: this.scope, rooms: [...rooms] });
  }

  async loadRooms(): Promise<RoomListItem[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (await this.db.rooms.get(this.scope))?.rooms ?? null;
  }

  async saveMessages(roomId: string, messages: Message[]): Promise<void> {
    await this.guard.check();
    const room = this.roomKey(roomId);
    const newest = [...messages].sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    await this.db.transaction('rw', this.db.messages, async () => {
      await this.db.messages.where('room').equals(room).delete();
      await this.db.messages.bulkPut(newest.map((m) => ({ k: `${room}:${m.seq}:${m.id}`, room, seq: m.seq, message: m })));
    });
  }

  async loadMessages(roomId: string): Promise<Message[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.db.messages.where('room').equals(this.roomKey(roomId)).sortBy('seq');
    if (rows.length === 0) {
      return null;
    }
    return rows.map((r) => r.message);
  }

  async saveOutbox(entries: OutboxEntry[]): Promise<void> {
    await this.guard.check();
    const k = this.k('outbox');
    await this.db.transaction('rw', this.db.outbox, async () => {
      await this.db.outbox.where('k').startsWith(k).delete();
      await this.db.outbox.bulkPut(entries.map((e) => ({ k: `${k}:${e.id}`, order: e.order, entry: e })));
    });
  }

  async loadOutbox(): Promise<OutboxEntry[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.db.outbox.where('k').startsWith(this.k('outbox')).sortBy('order');
    if (rows.length === 0) {
      return null;
    }
    return rows.map((r) => r.entry);
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      this.db.rooms.where('k').equals(this.scope).delete(),
      this.db.messages.where('room').startsWith(`${this.scope}:`).delete(),
      this.db.outbox.where('k').startsWith(this.k('outbox')).delete(),
      this.db.meta.delete(`${this.scope}@version`),
    ]);
  }

  async delete(): Promise<void> {
    await this.db.delete();
  }

  private roomKey(roomId: string): string {
    return `${this.scope}:${roomId}`;
  }

  private k(suffix: string): string {
    return `${this.scope}:${suffix}`;
  }
}

export interface DexieAiCacheOptions {
  userId: string;
  messageLimit?: number;
  schemaVersion?: number;
  dbName?: string;
}

export class DexieAiCacheAdapter implements AiCacheAdapter {
  private readonly db: CacheDb;
  private readonly scope: string;
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;

  constructor(opts: DexieAiCacheOptions) {
    this.db = openDb(opts.dbName ?? 'banana-chat-cache');
    this.scope = `ai:${opts.userId}`;
    this.messageLimit = opts.messageLimit ?? 100; // TC-CORE-050: 100/conversation
    const versionKey = `${this.scope}@version`;
    this.guard = new SchemaVersionGuard(
      async () => (await this.db.meta.get(versionKey))?.version ?? null,
      async (v) => {
        await this.db.meta.put({ k: versionKey, version: v });
      },
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  async saveConversations(list: AiConversationSummary[]): Promise<void> {
    await this.guard.check();
    await this.db.aiConversations.put({ k: this.scope, list: [...list] });
  }

  async loadConversations(): Promise<AiConversationSummary[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (await this.db.aiConversations.get(this.scope))?.list ?? null;
  }

  async saveMessages(conversationId: string, messages: AiMessage[]): Promise<void> {
    await this.guard.check();
    const conversation = `${this.scope}:${conversationId}`;
    const newest = [...messages].filter((m) => m.seq > 0).sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    await this.db.transaction('rw', this.db.aiMessages, async () => {
      await this.db.aiMessages.where('conversation').equals(conversation).delete();
      await this.db.aiMessages.bulkPut(
        newest.map((m) => ({ k: `${conversation}:${m.seq}:${m.id}`, conversation, seq: m.seq, message: m })),
      );
    });
  }

  async loadMessages(conversationId: string): Promise<AiMessage[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.db.aiMessages.where('conversation').equals(`${this.scope}:${conversationId}`).sortBy('seq');
    if (rows.length === 0) {
      return null;
    }
    return rows.map((r) => r.message);
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      this.db.aiConversations.where('k').equals(this.scope).delete(),
      this.db.aiMessages.where('conversation').startsWith(`${this.scope}:`).delete(),
      this.db.meta.delete(`${this.scope}@version`),
    ]);
  }

  async delete(): Promise<void> {
    await this.db.delete();
  }
}
