import type { Message } from '@banana-chat/shared';

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
  private state: MessageStoreState = { messages: [], needsFill: null, fillTimedOut: false };
  private fillTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Replace everything (initial page load) — page itself must be contiguous. */
  replace(messages: Message[]): MessageStoreState {
    this.byId.clear();
    for (const message of messages) {
      this.byId.set(message.id, message);
    }
    this.seeded = true;
    this.clearTimer();
    this.state = { messages: [...this.byId.values()].sort((a, b) => a.seq - b.seq), needsFill: null, fillTimedOut: false };
    this.emit(this.state);
    return this.state;
  }

  add(incoming: Message | Message[]): MessageStoreState {
    for (const message of Array.isArray(incoming) ? incoming : [incoming]) {
      this.insert(message);
    }
    this.recompute();
    return this.state;
  }

  /** Optimistic send keyed by client_message_id; server confirm replaces it. */
  confirmClientMessage(clientMessageId: string, confirmed: Message): void {
    const optimistic = [...this.byId.values()].find((m) => m.client_message_id === clientMessageId);
    if (optimistic !== undefined) {
      this.byId.delete(optimistic.id);
    }
    this.add(confirmed);
  }

  /** A gap fill arrived — merge, clear flags. */
  fillDelivered(messages: Message[]): void {
    this.clearTimer();
    for (const message of messages) {
      this.insert(message);
    }
    this.recompute();
  }

  dispose(): void {
    this.clearTimer();
  }

  private insert(message: Message): void {
    if (this.byId.has(message.id)) {
      this.byId.set(message.id, { ...this.byId.get(message.id)!, ...message });
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
  }

  private recompute(): void {
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
        this.state = { messages: sorted.slice(0, cut), needsFill: gap, fillTimedOut: false };
        this.armTimer();
        this.emit(this.state);
        return;
      }
    }

    this.clearTimer();
    this.state = { messages: sorted, needsFill: null, fillTimedOut: false };
    this.emit(this.state);
  }

  private armTimer(): void {
    this.clearTimer();
    this.fillTimer = setTimeout(() => {
      this.clearTimer();
      const all = [...this.byId.values()].sort((a, b) => a.seq - b.seq);
      this.state = { messages: all, needsFill: null, fillTimedOut: true };
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
