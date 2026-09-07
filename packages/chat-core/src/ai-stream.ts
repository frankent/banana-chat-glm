import type { AiMessage, AiStreamEvent } from '@banana-chat/shared';

/**
 * FR-AI-018 — index-ordered delta assembler for one generating message.
 *
 * Deltas arrive as (index, delta) pairs over private-user.{uid}. The store
 * applies them strictly in index order; a gap means we missed an event, so it
 * flags needsResync — the caller then GETs /ai/messages/{id} (API-117) and
 * calls resync() with the authoritative partial_content + last_index.
 *
 * Pure logic, no I/O: the web app owns the Echo subscription and fetch.
 */
export interface AiStreamState {
  messageId: string;
  status: 'pending' | 'streaming' | 'completed' | 'cancelled' | 'failed';
  /** concatenated text, only meaningful while streaming */
  content: string;
  /** highest contiguous index applied (-1 = nothing applied) */
  appliedIndex: number;
  /** a gap was detected — caller must resync from API-117 */
  needsResync: boolean;
  message: AiMessage | null;
}

export interface AiStreamStore {
  /** live streams keyed by message id */
  streams: Map<string, AiStreamState>;
  /** event names seen since the last drain (for tests/debugging) */
  apply(e: AiStreamEvent): void;
  /** seed/overwrite a stream from an API payload (send response or resync) */
  seed(message: AiMessage): AiStreamState;
  /** authoritative replace after GET /ai/messages/{id} */
  resync(messageId: string, partialContent: string | null, lastIndex: number | null, message: AiMessage): void;
  get(messageId: string): AiStreamState | undefined;
  snapshot(): AiStreamState[];
}

export function createAiStreamStore(): AiStreamStore {
  const streams = new Map<string, AiStreamState>();

  const ensure = (messageId: string): AiStreamState => {
    let s = streams.get(messageId);
    if (s === undefined) {
      s = { messageId, status: 'pending', content: '', appliedIndex: -1, needsResync: false, message: null };
      streams.set(messageId, s);
    }
    return s;
  };

  const finalize = (s: AiStreamState, message: AiMessage): void => {
    s.status = message.status;
    s.content = message.content ?? s.content;
    s.message = message;
    s.needsResync = false;
    streams.set(message.id, s);
    // a finalized stream is complete — drop it shortly is the caller's job;
    // keep it so late events (e.g. duplicate completed) are idempotent.
  };

  return {
    streams,

    apply(e: AiStreamEvent): void {
      switch (e.event) {
        case 'ai.message.started': {
          const s = ensure(e.message_id);
          s.status = 'streaming';
          s.appliedIndex = Math.max(s.appliedIndex, -1);
          break;
        }
        case 'ai.message.delta': {
          const s = ensure(e.message_id);
          if (s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') {
            break; // late delta after finalization — ignore
          }
          if (e.index <= s.appliedIndex) {
            break; // duplicate/replayed flush — ignore (at-most-once render)
          }
          if (e.index > s.appliedIndex + 1) {
            s.needsResync = true; // gap → caller fetches API-117
            break;
          }
          s.status = 'streaming';
          s.content += e.delta;
          s.appliedIndex = e.index;
          break;
        }
        case 'ai.message.completed': {
          finalize(ensure(e.message.id), e.message);
          break;
        }
        case 'ai.message.failed': {
          const s = ensure(e.message_id);
          s.status = 'failed';
          s.needsResync = false;
          s.message = { ...s.message, id: e.message_id, status: 'failed', error_code: e.error_code } as AiMessage;
          break;
        }
        // conversation-level events don't touch per-message streams
        case 'ai.conversation.updated':
        case 'ai.conversation.compacted':
        case 'ai.conversation.deleted':
          break;
      }
    },

    seed(message: AiMessage): AiStreamState {
      const s = ensure(message.id);
      s.message = message;
      if (message.status === 'pending' || message.status === 'streaming') {
        s.status = message.status;
        // seed from API-117 partial: jump the cursor to last_index
        if (message.partial_content !== null && message.partial_content !== undefined) {
          s.content = message.partial_content;
          s.appliedIndex = message.last_index ?? -1;
        }
      } else {
        s.status = message.status;
        s.content = message.content ?? '';
        s.appliedIndex = Number.MAX_SAFE_INTEGER;
      }
      return s;
    },

    resync(messageId, partialContent, lastIndex, message): void {
      const s = ensure(messageId);
      s.needsResync = false;
      s.message = message;
      s.status = message.status;
      s.appliedIndex = lastIndex ?? -1;
      s.content =
        message.status === 'completed' || message.status === 'cancelled'
          ? (message.content ?? '')
          : (partialContent ?? '');
    },

    get: (messageId) => streams.get(messageId),

    snapshot: () => [...streams.values()],
  };
}
