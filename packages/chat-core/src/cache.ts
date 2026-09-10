import type { AttachmentKind, Message, RoomListItem } from '@banana-chat/shared';

/**
 * TASK-CORE-007 (FR-OFF-001) — platform-agnostic cache contract.
 *
 * Every adapter is scoped to (user_id, workspace_id) — data written under one
 * scope must never be visible under another. `clearAll()` wipes everything the
 * adapter instance can reach (used on logout, TC-CORE-021).
 */
export const CACHE_SCHEMA_VERSION = 1;

export interface CacheScope {
  userId: string;
  workspaceId: string;
}

export function scopeKey({ userId, workspaceId }: CacheScope): string {
  return `${userId}:${workspaceId}`;
}

/** TC-CORE-032 / FR-OFF-002 — outbox rows persisted through the adapter. */
export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxAttachmentDraft {
  /** local file path/uri — uploaded when back online (FR-OFF-002) */
  local_path: string;
  /** Already uploaded; retained across retry/restart. */
  attachment_id?: string;
  kind: AttachmentKind;
  mime_type: string;
  original_name: string;
  size_bytes: number;
}

export interface OutboxEntry {
  id: string;
  /** enqueue counter — deterministic FIFO tiebreak for same-second rows */
  order: number;
  status: OutboxStatus;
  room_id: string;
  workspace_id: string;
  client_message_id: string;
  body: string | null;
  attachments: OutboxAttachmentDraft[];
  attempts: number;
  last_error: string | null;
  created_local_at: string;
}

export interface CacheAdapter {
  saveRooms(rooms: RoomListItem[]): Promise<void>;
  loadRooms(): Promise<RoomListItem[] | null>;
  /** full-room snapshot; adapter keeps only the newest `messageLimit` rows */
  saveMessages(roomId: string, messages: Message[]): Promise<void>;
  loadMessages(roomId: string): Promise<Message[] | null>;
  saveOutbox(entries: OutboxEntry[]): Promise<void>;
  loadOutbox(): Promise<OutboxEntry[] | null>;
  clearAll(): Promise<void>;
}

/**
 * TC-CORE-024 — cache schema version mismatch → wipe. Adapters consult the
 * guard before every load; a stale version nukes the backing store and
 * re-stamps it, so callers just see empty caches.
 */
export class SchemaVersionGuard {
  constructor(
    private readonly read: () => number | null | undefined | Promise<number | null | undefined>,
    private readonly write: (version: number) => void | Promise<void>,
    private readonly wipe: () => void | Promise<void>,
    private readonly expected: number,
  ) {}

  /** true = version matched (or was freshly stamped); false = data was wiped */
  async check(): Promise<boolean> {
    const stored = await this.read();
    if (stored === undefined || stored === null) {
      await this.write(this.expected);
      return true;
    }
    if (stored !== this.expected) {
      await this.wipe();
      await this.write(this.expected);
      return false;
    }
    return true;
  }
}

export interface MemoryCacheOptions {
  scope: CacheScope;
  /** newest-N rows kept per room (FR-OFF-001: 200 mobile / 50 web) */
  messageLimit?: number;
  schemaVersion?: number;
  /** shared map so two adapters can point at the same store (contract tests) */
  backing?: Map<string, unknown>;
}

/** Reference implementation — also the in-memory fallback for tests/SSR. */
export class MemoryCacheAdapter implements CacheAdapter {
  private readonly store: Map<string, unknown>;
  private readonly scope: string;
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;

  constructor(opts: MemoryCacheOptions) {
    this.store = opts.backing ?? new Map();
    this.scope = scopeKey(opts.scope);
    this.messageLimit = opts.messageLimit ?? 200;
    const versionKey = `${this.scope}@version`;
    this.guard = new SchemaVersionGuard(
      () => (this.store.get(versionKey) as number | undefined) ?? null,
      (v) => void this.store.set(versionKey, v),
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  async saveRooms(rooms: RoomListItem[]): Promise<void> {
    await this.guard.check();
    this.store.set(this.k('rooms'), [...rooms]);
  }

  async loadRooms(): Promise<RoomListItem[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (this.store.get(this.k('rooms')) as RoomListItem[] | undefined) ?? null;
  }

  async saveMessages(roomId: string, messages: Message[]): Promise<void> {
    await this.guard.check();
    const newest = [...messages].sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    this.store.set(this.k(`msg:${roomId}`), newest);
  }

  async loadMessages(roomId: string): Promise<Message[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (this.store.get(this.k(`msg:${roomId}`)) as Message[] | undefined) ?? null;
  }

  async saveOutbox(entries: OutboxEntry[]): Promise<void> {
    await this.guard.check();
    this.store.set(this.k('outbox'), [...entries]);
  }

  async loadOutbox(): Promise<OutboxEntry[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (this.store.get(this.k('outbox')) as OutboxEntry[] | undefined) ?? null;
  }

  async clearAll(): Promise<void> {
    for (const key of [...this.store.keys()]) {
      if (key === `${this.scope}@version` || key.startsWith(`${this.scope}:`)) {
        this.store.delete(key);
      }
    }
  }

  private k(suffix: string): string {
    return `${this.scope}:${suffix}`;
  }
}
