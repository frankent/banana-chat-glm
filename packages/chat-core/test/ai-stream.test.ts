import { describe, expect, it } from 'vitest';
import { createAiStreamStore } from '../src/ai-stream.js';
import type { AiMessage } from '@banana-chat/shared';

const msg = (id: string, status: AiMessage['status'], content: string | null = null): AiMessage => ({
  id,
  conversation_id: 'c1',
  seq: 2,
  role: 'assistant',
  status,
  content,
  client_message_id: null,
  parent_message_id: null,
  model: 'glm-5.2',
  finish_reason: null,
  tokens_prompt: null,
  tokens_completion: null,
  error_code: null,
  created_at: '2026-09-07T00:00:00Z',
  completed_at: null,
});

describe('TC-CORE-041..046 ai stream assembler (FR-AI-003/018)', () => {
  it('TC-CORE-041 applies indexed deltas in order and concatenates content', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.started', conversation_id: 'c1', message_id: 'm1' });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 0, delta: 'สวัสดี' });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 1, delta: 'ครับ' });

    const s = store.get('m1')!;
    expect(s.status).toBe('streaming');
    expect(s.content).toBe('สวัสดีครับ');
    expect(s.appliedIndex).toBe(1);
    expect(s.needsResync).toBe(false);
  });

  it('TC-CORE-042 detects a gap → needsResync and withholds the skipped delta', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.started', conversation_id: 'c1', message_id: 'm1' });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 0, delta: 'a' });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 2, delta: 'c' }); // missed 1

    const s = store.get('m1')!;
    expect(s.content).toBe('a'); // 2 not applied
    expect(s.needsResync).toBe(true);

    // the missing index arriving later still applies — but the flag stays set
    // because the withheld index-2 delta was lost, only resync() can clear it
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 1, delta: 'b' });
    expect(s.content).toBe('ab');
    expect(s.needsResync).toBe(true);
  });

  it('resync() replaces state from API-117 and clears the gap flag', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 5, delta: 'x' });
    expect(store.get('m1')!.needsResync).toBe(true);

    store.resync('m1', 'abcde', 4, msg('m1', 'streaming'));
    const s = store.get('m1')!;
    expect(s.needsResync).toBe(false);
    expect(s.content).toBe('abcde');
    expect(s.appliedIndex).toBe(4);

    // stream resumes cleanly at 5
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 5, delta: 'f' });
    expect(s.content).toBe('abcdef');
  });

  it('TC-CORE-042 duplicates and late deltas after completion are ignored', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 0, delta: 'a' });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 0, delta: 'a' }); // replay
    store.apply({ event: 'ai.message.completed', message: msg('m1', 'completed', 'a') });
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 1, delta: 'z' }); // late

    const s = store.get('m1')!;
    expect(s.status).toBe('completed');
    expect(s.content).toBe('a');
  });

  it('seeds from a 202 send response and marks failed on ai.message.failed', () => {
    const store = createAiStreamStore();
    store.seed(msg('m1', 'pending'));
    expect(store.get('m1')!.status).toBe('pending');

    store.apply({ event: 'ai.message.failed', conversation_id: 'c1', message_id: 'm1', error_code: 'AI_PROVIDER_ERROR' });
    const s = store.get('m1')!;
    expect(s.status).toBe('failed');
    expect(s.message?.error_code).toBe('AI_PROVIDER_ERROR');
  });

  it('cancelled completion keeps the partial content', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.delta', conversation_id: 'c1', message_id: 'm1', index: 0, delta: 'ครึ่ง' });
    store.apply({ event: 'ai.message.completed', message: { ...msg('m1', 'cancelled', 'ครึ่ง'), finish_reason: 'cancelled' } });

    const s = store.get('m1')!;
    expect(s.status).toBe('cancelled');
    expect(s.content).toBe('ครึ่ง');
  });

  it('conversation-level events are harmless no-ops', () => {
    const store = createAiStreamStore();
    expect(() => {
      store.apply({ event: 'ai.conversation.updated', conversation_summary: { id: 'c1', title: null, title_source: null, message_count: 2, last_message_at: null, archived_at: null, generating: false } });
      store.apply({ event: 'ai.conversation.compacted', conversation_id: 'c1' });
      store.apply({ event: 'ai.conversation.deleted', conversation_id: 'c1' });
    }).not.toThrow();
    expect(store.snapshot()).toHaveLength(0);
  });
});
