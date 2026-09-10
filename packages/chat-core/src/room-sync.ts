import type { MessagePage } from '@banana-chat/shared';
import type { MessageStore } from './message-store.js';

/** FR-RT-002: catch up the loaded window (including missed edits/deletions). */
export class RoomSync {
  private running: Promise<void> | null = null;
  constructor(private store: MessageStore,
    private fetchPage: (options: { after_seq?: number; limit: number }) => Promise<MessagePage>,
    private active: () => boolean = () => true) {}
  refresh(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run() {
    let after: number | undefined = this.store.getState().messages.at(0)?.seq;
    after = after === undefined ? undefined : Math.max(0, after - 1);
    while (this.active()) {
      const page = await this.fetchPage({ after_seq: after, limit: 100 });
      if (!this.active()) return;
      this.store.mergePage(page.messages);
      const tail = page.messages.at(-1)?.seq;
      if (!page.has_more_after || tail === undefined || (after !== undefined && tail <= after)) return;
      after = tail;
    }
  }
}

/** FR-READ-001: trailing/coalesced receipts, visibility rechecked at delivery. */
export class ReadReceiptReporter {
  private latest = 0;
  private sent = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private send: (seq: number) => Promise<unknown>, private visible: () => boolean, private interval = 1000) {}
  observe(seq: number) {
    this.latest = Math.max(this.latest, seq);
    if (!this.disposed && !this.timer && this.latest > this.sent && this.visible()) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.disposed || !this.visible()) return;
        const seq = this.latest;
        this.sent = seq;
        void this.send(seq).catch(() => { this.sent = 0; });
      }, this.interval);
    }
  }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); }
}

/** EVT-010/011/012: identical room-message interpretation on every platform. */
export function applyRoomEvent(store: MessageStore, event: string, data: { message?: import('@banana-chat/shared').Message; message_id?: string; delete_reason?: string | null }) {
  if (event === 'message.deleted' && data.message_id) store.markDeleted(data.message_id, new Date().toISOString(), data.delete_reason ?? 'sender');
  else if (data.message && (event === 'message.created' || event === 'message.updated')) store.add(data.message);
}
