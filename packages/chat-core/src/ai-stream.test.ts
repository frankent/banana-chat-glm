import { describe, expect, it } from 'vitest';
import { createAiStreamStore } from './ai-stream';
import type { AiMessage, AiToolStep } from '@banana-chat/shared';

const step = (over: Partial<AiToolStep> = {}): AiToolStep => ({
  id: 'call_1', tool: 'terminal', label: 'echo hello', emoji: '💻', status: 'running', at_char: 14, ...over,
});

describe('agent steps on a live stream', () => {
  it('keeps the label from the running frame when the completed frame omits it', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.started', conversation_id: 'c1', message_id: 'm1' });
    store.apply({ event: 'ai.message.tool', conversation_id: 'c1', message_id: 'm1', step: step() });
    store.apply({
      event: 'ai.message.tool', conversation_id: 'c1', message_id: 'm1',
      // what the agent actually sends second: id + status, nothing else
      step: { id: 'call_1', tool: 'terminal', label: null, emoji: null, status: 'completed', at_char: 14 },
    });

    const steps = store.get('m1')?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('completed');
    expect(steps[0].label).toBe('echo hello');
    expect(steps[0].emoji).toBe('💻');
  });

  it('keeps distinct calls apart and preserves arrival order', () => {
    const store = createAiStreamStore();
    store.apply({ event: 'ai.message.tool', conversation_id: 'c1', message_id: 'm1', step: step() });
    store.apply({ event: 'ai.message.tool', conversation_id: 'c1', message_id: 'm1', step: step({ id: 'call_2', label: 'ls -la', at_char: 40 }) });

    expect((store.get('m1')?.steps ?? []).map(s => s.id)).toEqual(['call_1', 'call_2']);
  });

  it('a reload restores the steps alongside the partial text', () => {
    const store = createAiStreamStore();
    const message = {
      id: 'm1', conversation_id: 'c1', seq: 2, role: 'assistant', status: 'streaming',
      content: null, partial_content: 'กำลังดูให้ค่ะ ', last_index: 0, steps: [step()],
    } as unknown as AiMessage;

    const state = store.seed(message);
    expect(state.content).toBe('กำลังดูให้ค่ะ ');
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].label).toBe('echo hello');
  });
});

describe('step placement across astral characters', () => {
  it('counts the same units PHP counted, so an emoji does not shift the card', () => {
    // mb_strlen('ดูให้ 🍒 ') is 8 code points; the same string is 9 UTF-16 units
    const text = 'ดูให้ 🍒 แล้วนะ';
    const atChar = 8;

    const chars = Array.from(text);
    expect(chars.length).not.toBe(text.length); // the two counts really do differ
    expect(chars.slice(0, atChar).join('')).toBe('ดูให้ 🍒 ');
    expect(text.slice(0, atChar)).not.toBe('ดูให้ 🍒 '); // what the naive slice would have done
  });
});
