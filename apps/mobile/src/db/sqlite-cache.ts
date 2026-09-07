import type { AiConversationSummary, AiMessage, Message, RoomListItem } from '@banana-chat/shared';
import {
  CACHE_SCHEMA_VERSION,
  SchemaVersionGuard,
  scopeKey,
  type AiCacheAdapter,
  type CacheAdapter,
  type CacheScope,
  type OutboxEntry,
} from '@banana-chat/chat-core';
import type { MobileSqliteDatabase } from './driver';
import { migrateDb } from './schema';

/**
 * TASK-MOB-005 — SQLite CacheAdapter (FR-OFF-001 mobile: rooms, members and
 * newest 200 messages/room). Passes the same contract suite as the web
 * IndexedDB adapter (TC-MOB-002).
 */
export interface SqliteCacheOptions {
  db: MobileSqliteDatabase;
  scope: CacheScope;
  messageLimit?: number;
  schemaVersion?: number;
}

export class SqliteCacheAdapter implements CacheAdapter {
  private readonly scope: string;
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;
  private ready: Promise<void> | null = null;

  constructor(private readonly opts: SqliteCacheOptions) {
    this.scope = scopeKey(opts.scope);
    this.messageLimit = opts.messageLimit ?? 200; // FR-OFF-001 mobile: 200/room
    this.guard = new SchemaVersionGuard(
      async () => {
        const row = await opts.db.getFirstAsync<{ value: string }>('SELECT value FROM cache_meta WHERE key = ?', [
          `${this.scope}@version`,
        ]);
        return row === null ? null : Number(row.value);
      },
      async (v) => {
        await opts.db.runAsync('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)', [`${this.scope}@version`, String(v)]);
      },
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  /** lazy one-time migration; every public method funnels through it */
  private ensure(): Promise<void> {
    this.ready ??= migrateDb(this.opts.db);
    return this.ready;
  }

  async saveRooms(rooms: RoomListItem[]): Promise<void> {
    await this.ensure();
    await this.guard.check();
    await this.opts.db.runAsync('INSERT OR REPLACE INTO cache_rooms (scope, rooms) VALUES (?, ?)', [
      this.scope,
      JSON.stringify(rooms),
    ]);
  }

  async loadRooms(): Promise<RoomListItem[] | null> {
    await this.ensure();
    if (!(await this.guard.check())) {
      return null;
    }
    const row = await this.opts.db.getFirstAsync<{ rooms: string }>('SELECT rooms FROM cache_rooms WHERE scope = ?', [this.scope]);
    return row === null ? null : (JSON.parse(row.rooms) as RoomListItem[]);
  }

  async saveMessages(roomId: string, messages: Message[]): Promise<void> {
    await this.ensure();
    await this.guard.check();
    const newest = [...messages].sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    await this.opts.db.withTransaction(async () => {
      await this.opts.db.runAsync('DELETE FROM cache_messages WHERE scope = ? AND room_id = ?', [this.scope, roomId]);
      for (const m of newest) {
        await this.opts.db.runAsync('INSERT OR REPLACE INTO cache_messages (scope, room_id, seq, message) VALUES (?, ?, ?, ?)', [
          this.scope,
          roomId,
          m.seq,
          JSON.stringify(m),
        ]);
      }
    });
  }

  async loadMessages(roomId: string): Promise<Message[] | null> {
    await this.ensure();
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.opts.db.getAllAsync<{ message: string }>(
      'SELECT message FROM cache_messages WHERE scope = ? AND room_id = ? ORDER BY seq ASC',
      [this.scope, roomId],
    );
    return rows.length === 0 ? null : rows.map((r) => JSON.parse(r.message) as Message);
  }

  async saveOutbox(entries: OutboxEntry[]): Promise<void> {
    await this.ensure();
    await this.guard.check();
    await this.opts.db.withTransaction(async () => {
      await this.opts.db.runAsync('DELETE FROM cache_outbox WHERE scope = ?', [this.scope]);
      for (const e of entries) {
        await this.opts.db.runAsync('INSERT OR REPLACE INTO cache_outbox (scope, id, order_n, entry) VALUES (?, ?, ?, ?)', [
          this.scope,
          e.id,
          e.order,
          JSON.stringify(e),
        ]);
      }
    });
  }

  async loadOutbox(): Promise<OutboxEntry[] | null> {
    await this.ensure();
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.opts.db.getAllAsync<{ entry: string }>(
      'SELECT entry FROM cache_outbox WHERE scope = ? ORDER BY order_n ASC',
      [this.scope],
    );
    return rows.length === 0 ? null : rows.map((r) => JSON.parse(r.entry) as OutboxEntry);
  }

  async clearAll(): Promise<void> {
    await this.ensure();
    await this.opts.db.runAsync('DELETE FROM cache_messages WHERE scope = ?', [this.scope]);
    await this.opts.db.runAsync('DELETE FROM cache_outbox WHERE scope = ?', [this.scope]);
    await this.opts.db.runAsync('DELETE FROM cache_rooms WHERE scope = ?', [this.scope]);
    await this.opts.db.runAsync('DELETE FROM cache_meta WHERE key = ?', [`${this.scope}@version`]);
  }
}

export interface SqliteAiCacheOptions {
  db: MobileSqliteDatabase;
  userId: string;
  messageLimit?: number;
  schemaVersion?: number;
}

/** TASK-MOB-016 — AI conversations + newest 100 messages in SQLite (TC-MOB-056). */
export class SqliteAiCacheAdapter implements AiCacheAdapter {
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;
  private ready: Promise<void> | null = null;

  constructor(private readonly opts: SqliteAiCacheOptions) {
    this.messageLimit = opts.messageLimit ?? 100;
    const key = `ai:${opts.userId}@version`;
    this.guard = new SchemaVersionGuard(
      async () => {
        const row = await opts.db.getFirstAsync<{ value: string }>('SELECT value FROM cache_meta WHERE key = ?', [key]);
        return row === null ? null : Number(row.value);
      },
      async (v) => {
        await opts.db.runAsync('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)', [key, String(v)]);
      },
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  private ensure(): Promise<void> {
    this.ready ??= migrateDb(this.opts.db);
    return this.ready;
  }

  async saveConversations(list: AiConversationSummary[]): Promise<void> {
    await this.ensure();
    await this.guard.check();
    await this.opts.db.runAsync('INSERT OR REPLACE INTO ai_conversations (user_id, list) VALUES (?, ?)', [
      this.opts.userId,
      JSON.stringify(list),
    ]);
  }

  async loadConversations(): Promise<AiConversationSummary[] | null> {
    await this.ensure();
    if (!(await this.guard.check())) {
      return null;
    }
    const row = await this.opts.db.getFirstAsync<{ list: string }>('SELECT list FROM ai_conversations WHERE user_id = ?', [
      this.opts.userId,
    ]);
    return row === null ? null : (JSON.parse(row.list) as AiConversationSummary[]);
  }

  async saveMessages(conversationId: string, messages: AiMessage[]): Promise<void> {
    await this.ensure();
    await this.guard.check();
    const newest = [...messages].filter((m) => m.seq > 0).sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    await this.opts.db.withTransaction(async () => {
      await this.opts.db.runAsync('DELETE FROM ai_messages WHERE user_id = ? AND conversation_id = ?', [
        this.opts.userId,
        conversationId,
      ]);
      for (const m of newest) {
        await this.opts.db.runAsync('INSERT OR REPLACE INTO ai_messages (user_id, conversation_id, seq, message) VALUES (?, ?, ?, ?)', [
          this.opts.userId,
          conversationId,
          m.seq,
          JSON.stringify(m),
        ]);
      }
    });
  }

  async loadMessages(conversationId: string): Promise<AiMessage[] | null> {
    await this.ensure();
    if (!(await this.guard.check())) {
      return null;
    }
    const rows = await this.opts.db.getAllAsync<{ message: string }>(
      'SELECT message FROM ai_messages WHERE user_id = ? AND conversation_id = ? ORDER BY seq ASC',
      [this.opts.userId, conversationId],
    );
    return rows.length === 0 ? null : rows.map((r) => JSON.parse(r.message) as AiMessage);
  }

  async clearAll(): Promise<void> {
    await this.ensure();
    await this.opts.db.runAsync('DELETE FROM ai_messages WHERE user_id = ?', [this.opts.userId]);
    await this.opts.db.runAsync('DELETE FROM ai_conversations WHERE user_id = ?', [this.opts.userId]);
    await this.opts.db.runAsync('DELETE FROM cache_meta WHERE key = ?', [`ai:${this.opts.userId}@version`]);
  }
}
