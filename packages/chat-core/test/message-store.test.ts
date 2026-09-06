import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@banana-chat/shared';
import { MessageStore } from '../src/message-store.js';

let idCounter = 0;
function msg(seq: number, overrides: Partial<Message> = {}): Message {
  idCounter += 1;
  return {
    id: `m-${seq}-${idCounter}`,
    room_id: 'r1',
    workspace_id: 'w1',
    sender_id: 'u1',
    sender: null,
    type: 'text',
    body: `msg ${seq}`,
    seq,
    client_message_id: `cmid-${seq}-${idCounter}`,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: new Date(2026, 0, 1, 0, 0, 0, seq).toISOString(),
    attachments: [],
    ...overrides,
  };
}

describe('TC-CORE-001 seq ordering', () => {
  it('keeps messages ascending regardless of arrival order', () => {
    const store = new MessageStore('r1');
    store.add(msg(3));
    store.add(msg(1));
    store.add(msg(2));
    expect(store.allSeqs).toEqual([1, 2, 3]);
  });
});

describe('TC-CORE-002 dedupe', () => {
  it('drops duplicate ids', () => {
    const store = new MessageStore('r1');
    const one = msg(1);
    store.add(one);
    store.add({ ...one });
    expect(store.getState().messages).toHaveLength(1);
  });

  it('drops duplicate client_message_id (event + HTTP confirm)', () => {
    const store = new MessageStore('r1');
    store.add(msg(1, { client_message_id: 'cmid-x' }));
    store.add(msg(2, { client_message_id: 'cmid-x' }));
    expect(store.allSeqs).toEqual([1]);
  });
});

describe('TC-CORE-003 optimistic confirmation', () => {
  it('replaces the optimistic copy with the server copy', () => {
    const store = new MessageStore('r1');
    const optimistic = msg(99, { id: 'optimistic-1', client_message_id: 'cmid-opt' });
    store.add(optimistic);

    const confirmed = msg(1, { id: 'server-1', client_message_id: 'cmid-opt', body: 'hello' });
    store.confirmClientMessage('cmid-opt', confirmed);

    const messages = store.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('server-1');
    expect(messages[0]!.seq).toBe(1);
  });
});

describe('TC-CORE-004 gap-fill hold', () => {
  it('flags needsFill and withholds the tail when an event skips a seq', () => {
    const store = new MessageStore('r1');
    store.replace([msg(1), msg(2), msg(3)]);

    store.add(msg(7)); // missed 4-6

    const state = store.getState();
    expect(state.needsFill).toEqual({ roomId: 'r1', afterSeq: 3, beforeSeq: 7 });
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(state.messages.at(-1)!.seq).toBe(3);
  });

  it('fillDelivered merges the missing range and clears the flag', () => {
    const store = new MessageStore('r1');
    store.replace([msg(1), msg(2), msg(3)]);
    store.add(msg(7));

    store.fillDelivered([msg(4), msg(5), msg(6)]);

    const state = store.getState();
    expect(state.needsFill).toBeNull();
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('TC-CORE-005 fill timeout', () => {
  it('releases the tail with fillTimedOut when no fill arrives', () => {
    vi.useFakeTimers();
    const store = new MessageStore('r1', 10_000);
    store.replace([msg(1), msg(2)]);
    store.add(msg(5));

    vi.advanceTimersByTime(10_001);

    const state = store.getState();
    expect(state.fillTimedOut).toBe(true);
    expect(state.needsFill).toBeNull();
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 5]);
    vi.useRealTimers();
  });

  it('does not fire the timeout after a successful fill', () => {
    vi.useFakeTimers();
    const store = new MessageStore('r1', 10_000);
    store.replace([msg(1), msg(2)]);
    store.add(msg(4));
    store.fillDelivered([msg(3)]);

    vi.advanceTimersByTime(10_001);

    expect(store.getState().fillTimedOut).toBe(false);
    vi.useRealTimers();
  });
});

describe('TC-CORE-006 replace', () => {
  it('seeds an initial page without gap flags (tail pages start anywhere)', () => {
    const store = new MessageStore('r1');
    store.replace([msg(40), msg(41), msg(42)]);
    expect(store.getState().needsFill).toBeNull();
    expect(store.newestSeq).toBe(42);
  });
});
