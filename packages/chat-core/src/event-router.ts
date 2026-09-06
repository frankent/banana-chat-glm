import type { EventEnvelope, RealtimeEventName } from '@banana-chat/shared';

type Handler<T = unknown> = (data: T, envelope: EventEnvelope<T>) => void;

/**
 * TASK-CORE-005 — routes §9 envelopes by event name. Echo/pusher-internal
 * frames never reach handlers (the EchoProvider filters them before this).
 */
export class EventRouter {
  private handlers = new Map<string, Set<Handler>>();

  on<T>(event: RealtimeEventName, handler: Handler<T>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler);
  }

  dispatch<T>(envelope: EventEnvelope<T>): void {
    const set = this.handlers.get(envelope.event);
    if (set === undefined) {
      return;
    }
    for (const handler of set) {
      try {
        handler(envelope.data, envelope);
      } catch {
        // one bad handler must not break the stream
      }
    }
  }

  dispatchRaw(event: string, payload: unknown): void {
    const data = payload as { event?: string; workspace_id?: string; data?: unknown; emitted_at?: string };
    if (data && typeof data === 'object' && 'data' in data) {
      this.dispatch({
        event,
        workspace_id: data.workspace_id ?? '',
        data: data.data,
        emitted_at: data.emitted_at ?? new Date().toISOString(),
      });
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
