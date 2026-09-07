import type { AiConversationSummary, AiMessage } from '@banana-chat/shared';
import { CACHE_SCHEMA_VERSION, SchemaVersionGuard } from './cache.js';

/**
 * TASK-CORE-010 — AI cache adapter: conversation list + newest 100 messages
 * per conversation, cleared on logout (TC-CORE-050). Scoped by user only —
 * conversations belong to the user, not the workspace (DEC-015).
 */
export interface AiCacheAdapter {
  saveConversations(list: AiConversationSummary[]): Promise<void>;
  loadConversations(): Promise<AiConversationSummary[] | null>;
  saveMessages(conversationId: string, messages: AiMessage[]): Promise<void>;
  loadMessages(conversationId: string): Promise<AiMessage[] | null>;
  clearAll(): Promise<void>;
}

export interface MemoryAiCacheOptions {
  userId: string;
  /** newest-N rows kept per conversation (spec: 100) */
  messageLimit?: number;
  schemaVersion?: number;
  backing?: Map<string, unknown>;
}

export class MemoryAiCacheAdapter implements AiCacheAdapter {
  private readonly store: Map<string, unknown>;
  private readonly scope: string;
  private readonly messageLimit: number;
  private readonly guard: SchemaVersionGuard;

  constructor(opts: MemoryAiCacheOptions) {
    this.store = opts.backing ?? new Map();
    this.scope = `ai:${opts.userId}`;
    this.messageLimit = opts.messageLimit ?? 100;
    const versionKey = `${this.scope}@version`;
    this.guard = new SchemaVersionGuard(
      () => (this.store.get(versionKey) as number | undefined) ?? null,
      (v) => void this.store.set(versionKey, v),
      () => this.clearAll(),
      opts.schemaVersion ?? CACHE_SCHEMA_VERSION,
    );
  }

  async saveConversations(list: AiConversationSummary[]): Promise<void> {
    await this.guard.check();
    this.store.set(this.k('conversations'), [...list]);
  }

  async loadConversations(): Promise<AiConversationSummary[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (this.store.get(this.k('conversations')) as AiConversationSummary[] | undefined) ?? null;
  }

  async saveMessages(conversationId: string, messages: AiMessage[]): Promise<void> {
    await this.guard.check();
    // optimistic rows carry seq -1 — they sort before every server row
    const newest = [...messages].filter((m) => m.seq > 0).sort((a, b) => a.seq - b.seq).slice(-this.messageLimit);
    this.store.set(this.k(`conv:${conversationId}`), newest);
  }

  async loadMessages(conversationId: string): Promise<AiMessage[] | null> {
    if (!(await this.guard.check())) {
      return null;
    }
    return (this.store.get(this.k(`conv:${conversationId}`)) as AiMessage[] | undefined) ?? null;
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
