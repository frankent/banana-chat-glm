import type { Message } from '@banana-chat/shared';
import type { CacheAdapter, OutboxAttachmentDraft, OutboxEntry } from './cache.js';

/**
 * TASK-CORE-007 (FR-OFF-002) — offline outbox.
 *
 * Messages composed while offline are queued with status `pending` (no seq,
 * rendered after the room tail by created_local_at). Back online, entries
 * flush FIFO per room reusing the original client_message_id. 4xx fails
 * immediately; 5xx/network retries with backoff up to maxAttempts, then
 * stays `failed` for manual retry/delete. Every mutation persists through
 * the CacheAdapter, so the queue survives a restart (TC-CORE-025..032).
 */
export type OutboxSendResult =
  | { ok: true; message: Message }
  | { ok: false; retryable: false; error: string }
  | { ok: false; retryable: true; error: string };

export type OutboxSendFn = (entry: OutboxEntry) => Promise<OutboxSendResult>;

export interface OutboxDraft {
  roomId: string;
  workspaceId: string;
  body: string | null;
  clientMessageId?: string;
  attachments?: OutboxAttachmentDraft[];
}

export interface OutboxOptions {
  sender?: OutboxSendFn;
  /** called with the confirmed server message so the UI can replace the optimistic row */
  onDelivered?: (entry: OutboxEntry, message: Message) => void;
  maxAttempts?: number;
  /** backoff base for retryable failures: base * 2^(attempt-1) */
  baseRetryMs?: number;
}

function byOrder(a: OutboxEntry, b: OutboxEntry): number {
  return a.created_local_at === b.created_local_at
    ? a.order - b.order
    : (a.created_local_at < b.created_local_at ? -1 : 1);
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** transient in-memory flag: waiting for the backoff timer (never persisted) */
type HeldEntry = OutboxEntry & { hold?: boolean };

export class Outbox {
  private entries: HeldEntry[] = [];
  private online = false;
  private disposed = false;
  private writes: Promise<void> = Promise.resolve();
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private nextOrder = 1;

  sender: OutboxSendFn | null;
  onDelivered: ((entry: OutboxEntry, message: Message) => void) | null;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;

  constructor(
    private readonly cache: Pick<CacheAdapter, 'saveOutbox' | 'loadOutbox'>,
    opts: OutboxOptions = {},
  ) {
    this.sender = opts.sender ?? null;
    this.onDelivered = opts.onDelivered ?? null;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseRetryMs = opts.baseRetryMs ?? 1000;
  }

  /** TC-CORE-032 — hydrate the queue persisted by a previous session. */
  async restore(): Promise<void> {
    const loaded = await this.cache.loadOutbox();
    if (this.disposed) return;
    const existing = new Set(this.entries.map(e => e.id));
    this.entries = [...(loaded ?? []).filter(e => !existing.has(e.id)).map((e) => ({ ...e, status: e.status === 'sending' ? 'pending' as const : e.status })), ...this.entries];
    this.nextOrder = this.entries.reduce((max, e) => Math.max(max, e.order), 0) + 1;
    this.emit();
    if (this.online) {
      void this.flush();
    }
  }

  setSender(sender: OutboxSendFn): void {
    this.sender = sender;
    if (this.online) {
      void this.flush();
    }
  }

  /** going online triggers a flush (TC-CORE-026). */
  setOnline(online: boolean): void {
    if (this.disposed) return;
    this.online = online;
    if (online) {
      void this.flush();
    }
  }

  isOnline(): boolean {
    return this.online;
  }

  /** TC-CORE-025 — queued with status pending, no seq, ordered at the tail. */
  async enqueue(draft: OutboxDraft): Promise<OutboxEntry> {
    if (this.disposed) throw new Error('Outbox disposed');
    const entry: HeldEntry = {
      id: `ob-${randomId()}`,
      order: this.nextOrder++,
      status: 'pending',
      room_id: draft.roomId,
      workspace_id: draft.workspaceId,
      client_message_id: draft.clientMessageId ?? randomId(),
      body: draft.body,
      attachments: draft.attachments ?? [],
      attempts: 0,
      last_error: null,
      created_local_at: new Date().toISOString(),
    };
    this.entries.push(entry);
    try { await this.persist(); }
    catch (error) {
      this.entries = this.entries.filter(e => e.id !== entry.id);
      throw error;
    }
    this.emit();
    if (this.online) {
      void this.flush();
    }
    return entry;
  }

  get(id: string): OutboxEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  all(): OutboxEntry[] {
    return [...this.entries].sort(byOrder);
  }

  /** FIFO per room (global order = enqueue order). */
  entriesForRoom(roomId: string): OutboxEntry[] {
    return this.entries.filter((e) => e.room_id === roomId).sort(byOrder);
  }

  /** TC-CORE-030 — manual retry resets the attempt budget. */
  async retry(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined || entry.status !== 'failed') {
      return;
    }
    entry.status = 'pending';
    entry.attempts = 0;
    entry.last_error = null;
    await this.persist();
    this.emit();
    if (this.online) {
      void this.flush();
    }
  }

  /** TC-CORE-031 — drop a queued/pending entry. */
  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
    this.emit();
    if (this.online) void this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.online = false;
    this.onDelivered = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.listeners.clear();
    return this.writes.catch(() => undefined);
  }

  /**
   * TC-CORE-026..029 — send every non-held pending entry, oldest first.
   * Entries enqueued mid-flush are picked up by the follow-up pass.
   */
  async flush(): Promise<void> {
    if (this.disposed || this.sender === null || !this.online || this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      let queue = this.pendingQueue();
      while (queue.length > 0 && this.online && this.sender !== null) {
        for (const entry of queue.slice(0, 1)) {
          if (this.disposed || !this.online) break;
          if (!this.pendingQueue().some(e => e.id === entry.id)) continue;
          entry.status = 'sending';
          await this.persist();
          this.emit();
          if (this.disposed) return;

          let result: OutboxSendResult;
          try {
            result = await this.sender(entry);
          } catch (error) {
            result = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
          }

          if (this.disposed) return;
          if (result.ok) {
            // TC-CORE-027 — optimistic row is replaced by the confirmed message
            this.entries = this.entries.filter((e) => e.id !== entry.id);
            this.onDelivered?.(entry, result.message);
          } else if (result.retryable) {
            entry.attempts += 1;
            entry.last_error = result.error;
            if (entry.attempts >= this.maxAttempts) {
              entry.status = 'failed';
            } else {
              entry.status = 'pending';
              entry.hold = true;
              this.scheduleRetry(entry.attempts);
            }
          } else {
            // TC-CORE-028 — 4xx never retries
            entry.status = 'failed';
            entry.last_error = result.error;
          }
          await this.persist();
          this.emit();
        }
        queue = this.pendingQueue();
      }
    } finally {
      this.flushing = false;
    }
  }

  private pendingQueue(): HeldEntry[] {
    const blocked = new Set<string>();
    return [...this.entries].sort(byOrder).filter(e => {
      if (blocked.has(e.room_id)) return false;
      blocked.add(e.room_id);
      return e.status === 'pending' && e.hold !== true;
    });
  }

  private scheduleRetry(attempt: number): void {
    if (this.retryTimer !== null) {
      return; // one timer serves all held entries
    }
    const delay = this.baseRetryMs * 2 ** Math.max(0, attempt - 1);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      for (const entry of this.entries) {
        entry.hold = false;
      }
      void this.flush();
    }, delay);
  }

  private async persist(): Promise<void> {
    // `hold` is transient — strip it before writing through the adapter
    if (this.disposed) return;
    const snapshot = this.entries.map(({ hold: _hold, ...entry }) => ({ ...entry }));
    this.writes = this.writes.catch(() => undefined).then(() => this.cache.saveOutbox(snapshot));
    await this.writes;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
