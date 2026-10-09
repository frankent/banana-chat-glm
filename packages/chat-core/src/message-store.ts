import type { Message, ReactionCount, UserStub } from '@banana-chat/shared';

export interface GapFillRequest {
  roomId: string;
  afterSeq: number;
  beforeSeq: number;
}

export interface MessageStoreState {
  /** ascending by seq, no duplicates */
  messages: Message[];
  /** a hole exists after the contiguous window; consumer should fetch after_seq */
  needsFill: GapFillRequest | null;
  /** a fill was requested but nothing arrived within the timeout */
  fillTimedOut: boolean;
  /**
   * TC-CORE-023 — rows inserted above the previous head by the last
   * add()/fillDelivered() (cache hydrate → server sync). The UI anchors
   * scroll on this count so prepending doesn't jump the viewport.
   */
  prependCount: number;
}

/**
 * TASK-CORE-003 — seq-ordered, deduped message window per room.
 *
 * Invariants (TC-CORE-001..008):
 *  1. messages always sorted ascending by seq
 *  2. dedupe by id AND by client_message_id (optimistic + confirmed copies)
 *  3. once seeded (initial page), an event jumping seq flags needsFill and is
 *     withheld until fillDelivered() merges the missing range
 *  4. unresolved after timeoutMs → fillTimedOut flips and the tail is
 *     released so the UI can render with a "messages missing" notice
 */
export class MessageStore {
  private byId = new Map<string, Message>();
  private seeded = false;
  private state: MessageStoreState = { messages: [], needsFill: null, fillTimedOut: false, prependCount: 0 };
  private fillTimer: ReturnType<typeof setTimeout> | null = null;
  private reactionPending = new Set<string>();
  private reactionDirty = new Map<string, ReactionCount[][]>();
  private reactionTouched = new Map<string, number>();
  private reactionVersions = new Map<string, number>();

  constructor(
    public readonly roomId: string,
    private readonly timeoutMs = 10_000,
    private readonly emit: (state: MessageStoreState) => void = () => {},
  ) {}

  getState(): MessageStoreState {
    return this.state;
  }

  get newestSeq(): number {
    const messages = this.state.messages;
    return messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
  }

  get allSeqs(): number[] {
    return this.state.messages.map((m) => m.seq);
  }

  /**
   * Replace everything (initial page load) — page itself must be contiguous.
   * A row that was already loaded merges through the same rule as insert()
   * (mergeExisting: no undelete, no older edit, FR-MSG-012 summary freshness).
   */
  replace(messages: Message[], fetchedAt?: number): MessageStoreState {
    const previous = new Map(this.byId);
    this.byId.clear();
    for (const message of messages) {
      const before = previous.get(message.id);
      if (before === undefined) {
        this.byId.set(message.id, message);
        this.bumpReactionVersion(message.id);
      } else {
        this.byId.set(message.id, this.mergeExisting(before, message, fetchedAt));
      }
    }
    this.seeded = true;
    this.clearTimer();
    this.state = {
      messages: [...this.byId.values()].sort((a, b) => a.seq - b.seq),
      needsFill: null,
      fillTimedOut: false,
      prependCount: 0,
    };
    this.emit(this.state);
    return this.state;
  }

  /**
   * FR-MSG-009: preserve live deliveries while merging a fresh history page.
   * `fetchedAt` (ms, taken BEFORE the request; also accepted by add/fillDelivered
   * for older-page and gap-fill REST pages) lets a page that raced a reaction
   * change keep the newer local summary (FR-MSG-012).
   */
  mergePage(messages: Message[], fetchedAt?: number): void {
    for (const message of messages) this.insert(message, fetchedAt);
    this.seeded = true;
    this.recompute();
  }

  add(incoming: Message | Message[], fetchedAt?: number): MessageStoreState {
    const prepended = this.countPrepended(() => {
      for (const message of Array.isArray(incoming) ? incoming : [incoming]) {
        this.insert(message, fetchedAt);
      }
    });
    this.recompute(prepended);
    return this.state;
  }

  /** Optimistic send keyed by client_message_id; server confirm replaces it. */
  confirmClientMessage(clientMessageId: string, confirmed: Message, fetchedAt?: number): void {
    const optimistic = [...this.byId.values()].find((m) => m.client_message_id === clientMessageId);
    if (optimistic !== undefined) {
      this.byId.delete(optimistic.id);
    }
    this.add(confirmed, fetchedAt);
  }

  /** A gap fill arrived — merge, clear flags. */
  fillDelivered(messages: Message[], fetchedAt?: number): void {
    this.clearTimer();
    const prepended = this.countPrepended(() => {
      for (const message of messages) {
        this.insert(message, fetchedAt);
      }
    });
    this.recompute(prepended);
  }

  /**
   * EVT-012 message.deleted — the row stays (seq preserved) but becomes a
   * tombstone: body dropped, attachments gone (FR-MSG-006).
   */
  markDeleted(messageId: string, deletedAt: string, deleteReason: string): MessageStoreState {
    const existing = this.byId.get(messageId);
    if (existing !== undefined) {
      this.byId.set(messageId, { ...existing, body: null, attachments: [], reactions: [], my_reaction: null, deleted_at: deletedAt, delete_reason: deleteReason });
      this.bumpReactionVersion(messageId);
      this.recompute();
    }
    return this.state;
  }

  getMessage(messageId: string): Message | undefined {
    return this.byId.get(messageId);
  }

  /** FR-MSG-012 — a reaction request is in flight; REST/events must not clobber the optimistic state. */
  isReactionPending(messageId: string): boolean {
    return this.reactionPending.has(messageId);
  }

  beginReaction(messageId: string): boolean {
    if (this.reactionPending.has(messageId)) return false;
    this.reactionPending.add(messageId);
    return true;
  }

  /**
   * An event for this message was withheld while our request was in flight.
   * Its counts are kept so the caller can skip the refetch when every withheld
   * event already equals the response (our own echo).
   */
  markReactionDirty(messageId: string, snapshot: ReactionCount[]): void {
    if (!this.reactionPending.has(messageId)) return;
    this.reactionDirty.set(messageId, [...(this.reactionDirty.get(messageId) ?? []), snapshot]);
  }

  /** Ends the in-flight guard; returns the snapshots of events withheld meanwhile (null = none). */
  endReaction(messageId: string): ReactionCount[][] | null {
    this.reactionPending.delete(messageId);
    const withheld = this.reactionDirty.get(messageId) ?? null;
    this.reactionDirty.delete(messageId);
    return withheld;
  }

  /** Bumps on every summary write; a REST snapshot taken at version N is stale once this moves past N. */
  reactionVersion(messageId: string): number {
    return this.reactionVersions.get(messageId) ?? 0;
  }

  private bumpReactionVersion(messageId: string): void {
    this.reactionVersions.set(messageId, this.reactionVersion(messageId) + 1);
  }

  /**
   * FR-MSG-012 — overwrite the reaction summary of one loaded message.
   * `myReaction === undefined` keeps the viewer's own pick (events carry none).
   * Tombstones never carry reactions.
   */
  setReactions(messageId: string, reactions: ReactionCount[], myReaction?: string | null): MessageStoreState {
    const existing = this.byId.get(messageId);
    if (existing === undefined || existing.deleted_at) return this.state;
    this.reactionTouched.set(messageId, Date.now());
    this.bumpReactionVersion(messageId);
    this.byId.set(messageId, {
      ...existing,
      reactions,
      ...(myReaction === undefined ? {} : { my_reaction: myReaction }),
    });
    this.recompute();
    return this.state;
  }

  /**
   * FR-PROF-006 / EVT-087 — a member changed their profile (the event carries
   * only `user_id`). A refetch of the latest page merges fresh `sender` stubs
   * into THOSE rows only; every older loaded row by the same person would keep
   * the stale photo. Re-stamp every row whose sender appears in `senders`.
   * Only rows whose stub actually changed are replaced, so an idle refetch
   * emits nothing and no bubble re-renders.
   */
  updateSenders(senders: Iterable<UserStub | null | undefined>): MessageStoreState {
    const fresh = new Map<string, UserStub>();
    for (const sender of senders) if (sender) fresh.set(sender.id, sender);
    if (fresh.size === 0) return this.state;
    let changed = false;
    for (const [id, message] of this.byId) {
      const next = fresh.get(message.sender_id);
      if (next === undefined || message.sender === null || sameStub(message.sender, next)) continue;
      this.byId.set(id, { ...message, sender: { ...message.sender, ...next } });
      changed = true;
    }
    if (!changed) return this.state;
    this.state = { ...this.state, messages: this.state.messages.map((m) => this.byId.get(m.id) ?? m) };
    this.emit(this.state);
    return this.state;
  }

  dispose(): void {
    this.clearTimer();
  }

  /** The one place a loaded row absorbs an incoming copy; used by insert() and replace(). */
  private mergeExisting(previous: Message, message: Message, fetchedAt?: number): Message {
    if (previous.deleted_at && !message.deleted_at) return previous;
    if (message.deleted_at) {
      if (!previous.deleted_at) this.bumpReactionVersion(message.id);
      return { ...previous, ...message, reactions: [], my_reaction: null };
    }
    if (previous.edit_count > message.edit_count) return previous;
    const touched = this.reactionTouched.get(message.id);
    const staleSummary = fetchedAt !== undefined && touched !== undefined && fetchedAt <= touched;
    if (this.reactionPending.has(message.id) || staleSummary) {
      const { reactions: _r, my_reaction: _m, ...rest } = message;
      return { ...previous, ...rest };
    }
    if (message.reactions !== undefined || message.my_reaction !== undefined) this.bumpReactionVersion(message.id);
    return { ...previous, ...message };
  }

  private insert(message: Message, fetchedAt?: number): void {
    const previous = this.byId.get(message.id);
    if (previous !== undefined) {
      this.byId.set(message.id, this.mergeExisting(previous, message, fetchedAt));
      return;
    }
    if (message.client_message_id !== null) {
      for (const existing of this.byId.values()) {
        if (existing.client_message_id === message.client_message_id) {
          return; // duplicate delivery of the same logical message
        }
      }
    }
    this.byId.set(message.id, message);
    this.bumpReactionVersion(message.id);
  }

  /**
   * TC-CORE-023 — rows that landed above the current head. Cache hydrate
   * seeds the tail; the server sync then prepends older pages — the UI uses
   * the delta to keep the viewport anchored.
   */
  private countPrepended(merge: () => void): number {
    const headSeq = Math.min(Infinity, ...[...this.byId.values()].map((m) => m.seq));
    const before = [...this.byId.values()].filter((m) => m.seq < headSeq).length;
    merge();
    const after = [...this.byId.values()].filter((m) => m.seq < headSeq).length;
    return Math.max(0, after - before);
  }

  private recompute(prepended = 0): void {
    const sorted = [...this.byId.values()].sort((a, b) => a.seq - b.seq);

    if (this.seeded) {
      // contiguous run from the head; first skip marks the gap
      let cut = sorted.length;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.seq > sorted[i - 1]!.seq + 1) {
          cut = i;
          break;
        }
      }

      if (cut < sorted.length) {
        const gap = { roomId: this.roomId, afterSeq: sorted[cut - 1]!.seq, beforeSeq: sorted[cut]!.seq };
        this.state = { messages: sorted.slice(0, cut), needsFill: gap, fillTimedOut: false, prependCount: prepended };
        this.armTimer();
        this.emit(this.state);
        return;
      }
    }

    this.clearTimer();
    this.state = { messages: sorted, needsFill: null, fillTimedOut: false, prependCount: prepended };
    this.emit(this.state);
  }

  private armTimer(): void {
    this.clearTimer();
    this.fillTimer = setTimeout(() => {
      this.clearTimer();
      const all = [...this.byId.values()].sort((a, b) => a.seq - b.seq);
      this.state = { messages: all, needsFill: null, fillTimedOut: true, prependCount: 0 };
      this.emit(this.state);
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.fillTimer !== null) {
      clearTimeout(this.fillTimer);
      this.fillTimer = null;
    }
  }
}

function sameStub(a: UserStub, b: UserStub): boolean {
  return a.display_name === b.display_name
    && a.username === b.username
    && a.avatar_attachment_id === b.avatar_attachment_id
    && a.avatar?.sm === b.avatar?.sm
    && a.avatar?.md === b.avatar?.md
    && a.avatar?.animated === b.avatar?.animated;
}
