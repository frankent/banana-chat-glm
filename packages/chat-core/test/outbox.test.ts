import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@banana-chat/shared';
import { MemoryCacheAdapter, Outbox, type OutboxSendFn } from '../src/index.js';

/**
 * TASK-CORE-007 (FR-OFF-002) — outbox behavior, TC-CORE-025..032.
 */
function confirmed(entryClientMessageId: string, seq: number): Message {
  return {
    id: `server-${seq}`,
    room_id: 'room-1',
    workspace_id: 'ws-1',
    sender_id: 'u-1',
    sender: null,
    type: 'text',
    body: 'from the server',
    seq,
    client_message_id: entryClientMessageId,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: new Date().toISOString(),
    mentions: [],
    attachments: [],
  };
}

function makeOutbox(opts: { sender?: OutboxSendFn; maxAttempts?: number; baseRetryMs?: number } = {}) {
  const cache = new MemoryCacheAdapter({ scope: { userId: 'user-1', workspaceId: 'ws-1' } });
  const delivered: Array<{ entryId: string; message: Message }> = [];
  const outbox = new Outbox(cache, {
    sender: opts.sender,
    maxAttempts: opts.maxAttempts,
    baseRetryMs: opts.baseRetryMs,
    onDelivered: (entry, message) => delivered.push({ entryId: entry.id, message }),
  });
  return { cache, outbox, delivered };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Outbox', () => {
  it('TC-CORE-025 enqueues with status pending, no seq, ordered at the tail', async () => {
    const { outbox } = makeOutbox();
    const first = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'hello' });
    const second = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'again' });

    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(0);
    expect('seq' in first).toBe(false); // pending rows have no server seq
    expect(outbox.entriesForRoom('room-1').map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('TC-CORE-026 going online flushes FIFO per room with the original client_message_id', async () => {
    const sent: string[] = [];
    const sender: OutboxSendFn = async (entry) => {
      sent.push(entry.client_message_id);
      return { ok: true, message: confirmed(entry.client_message_id, sent.length + 100) };
    };
    const { outbox, delivered } = makeOutbox({ sender });

    const a1 = await outbox.enqueue({ roomId: 'room-A', workspaceId: 'ws-1', body: 'a1', clientMessageId: 'cmid-a1' });
    const a2 = await outbox.enqueue({ roomId: 'room-A', workspaceId: 'ws-1', body: 'a2', clientMessageId: 'cmid-a2' });
    const b1 = await outbox.enqueue({ roomId: 'room-B', workspaceId: 'ws-1', body: 'b1', clientMessageId: 'cmid-b1' });

    outbox.setSender(sender);
    outbox.setOnline(true);
    await vi.waitFor(() => expect(outbox.all()).toHaveLength(0));

    expect(sent).toEqual(['cmid-a1', 'cmid-a2', 'cmid-b1']);
    expect(delivered.map((d) => d.message.client_message_id)).toEqual(['cmid-a1', 'cmid-a2', 'cmid-b1']);
    expect(a1.client_message_id).toBe('cmid-a1');
  });

  it('TC-CORE-027 a confirmed send replaces the optimistic entry', async () => {
    const { outbox, delivered } = makeOutbox({
      sender: async (entry) => ({ ok: true, message: confirmed(entry.client_message_id, 42) }),
    });
    const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'x' });

    outbox.setOnline(true);
    await vi.waitFor(() => expect(outbox.all()).toHaveLength(0));

    expect(outbox.get(entry.id)).toBeNull();
    expect(delivered[0]?.message.seq).toBe(42);
  });

  it('TC-CORE-028 a 4xx failure fails immediately without retry', async () => {
    let calls = 0;
    const { outbox } = makeOutbox({
      sender: async () => {
        calls++;
        return { ok: false, retryable: false, error: 'FORBIDDEN' };
      },
    });
    const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'nope' });

    outbox.setOnline(true);
    await vi.waitFor(() => expect(outbox.get(entry.id)?.status).toBe('failed'));

    expect(calls).toBe(1);
    expect(outbox.get(entry.id)?.last_error).toBe('FORBIDDEN');
  });

  it('TC-CORE-029 network/5xx retries 3 times with backoff, then fails', async () => {
    let calls = 0;
    const { outbox } = makeOutbox({
      baseRetryMs: 1000,
      sender: async () => {
        calls++;
        return { ok: false, retryable: true, error: 'network down' };
      },
    });
    const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'retry me' });

    outbox.setOnline(true);
    await vi.waitFor(() => expect(calls).toBe(1));

    await vi.advanceTimersByTimeAsync(1000); // first backoff: base * 2^0
    await vi.waitFor(() => expect(calls).toBe(2));

    await vi.advanceTimersByTimeAsync(2000); // second backoff: base * 2^1
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() => expect(outbox.get(entry.id)?.status).toBe('failed'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(3); // no further attempts
  });

  it('TC-CORE-030 manual retry from failed sends again', async () => {
    let calls = 0;
    const { outbox } = makeOutbox({
      sender: async (entry) => {
        calls++;
        return calls === 1
          ? { ok: false, retryable: false, error: 'boom' }
          : { ok: true, message: confirmed(entry.client_message_id, 7) };
      },
    });
    const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'manual' });

    outbox.setOnline(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(outbox.get(entry.id)?.status).toBe('failed');

    await outbox.retry(entry.id);
    await vi.waitFor(() => expect(outbox.all()).toHaveLength(0));
    expect(calls).toBe(2);
  });

  it('TC-CORE-031 remove deletes a pending entry before it ever sends', async () => {
    let calls = 0;
    const { outbox } = makeOutbox({
      sender: async (entry) => {
        calls++;
        return { ok: true, message: confirmed(entry.client_message_id, 1) };
      },
    });
    const keep = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'keep' });
    const drop = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'drop' });

    await outbox.remove(drop.id);
    outbox.setOnline(true);
    await vi.waitFor(() => expect(outbox.all()).toHaveLength(0));

    expect(calls).toBe(1);
    expect(outbox.get(drop.id)).toBeNull();
    expect(outbox.get(keep.id)).toBeNull(); // delivered, not stuck
  });

  it('TC-CORE-032 the queue survives a restart via the CacheAdapter', async () => {
    const { cache, outbox } = makeOutbox();
    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'first', clientMessageId: 'cmid-1' });
    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'second', clientMessageId: 'cmid-2' });

    // a fresh instance over the same persisted cache (app restart)
    const revived = new Outbox(cache);
    await revived.restore();

    expect(revived.all().map((e) => e.client_message_id)).toEqual(['cmid-1', 'cmid-2']);
    expect(revived.all().every((e) => e.status === 'pending')).toBe(true);
  });

  it('a throwing sender counts as a retryable network failure', async () => {
    let calls = 0;
    const { outbox } = makeOutbox({
      baseRetryMs: 100,
      sender: async () => {
        calls++;
        throw new Error('connection reset');
      },
    });
    const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'flaky' });

    outbox.setOnline(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(outbox.get(entry.id)?.status).toBe('failed'));

    expect(calls).toBe(3);
    expect(outbox.get(entry.id)?.last_error).toBe('connection reset');
  });
});

it('TC-CORE-032 restores interrupted sending entries as pending', async () => {
  const { outbox, cache } = makeOutbox();
  const entry = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'survive crash' });
  await cache.saveOutbox([{ ...entry, status: 'sending' }]);
  const restarted = new Outbox(cache);
  await restarted.restore();
  expect(restarted.get(entry.id)?.status).toBe('pending');
});

it('TC-CORE-026 a retry blocks later messages in the same room, not other rooms', async () => {
  const calls: string[] = [];
  const { outbox } = makeOutbox({ sender: async entry => {
    calls.push(entry.body!);
    return entry.body === 'first' ? { ok: false, retryable: true, error: 'offline' } : { ok: true, message: confirmed(entry.client_message_id, 1) };
  } });
  await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'first' });
  await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'second' });
  await outbox.enqueue({ roomId: 'room-2', workspaceId: 'ws-1', body: 'other' });
  outbox.setOnline(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toEqual(['first', 'other']);
  outbox.dispose();
});

it('TC-CORE-031 removing a failed room head releases its next pending message', async () => {
  const sent: string[] = [];
  const { outbox } = makeOutbox({ sender: async e => {
    sent.push(e.body!);
    return e.body === 'first' ? { ok: false, retryable: false, error: 'forbidden' } : { ok: true, message: confirmed(e.client_message_id, 1) };
  } });
  const first = await outbox.enqueue({ roomId: 'r', workspaceId: 'w', body: 'first' });
  await outbox.enqueue({ roomId: 'r', workspaceId: 'w', body: 'second' });
  outbox.setOnline(true);
  await vi.waitFor(() => expect(outbox.get(first.id)?.status).toBe('failed'));
  expect(sent).toEqual(['first']);
  await outbox.remove(first.id);
  await vi.waitFor(() => expect(sent).toEqual(['first', 'second']));
  await outbox.dispose();
});
it('TC-CORE-021 disposing while persistence is pending prevents a new network send', async () => {
  const sender = vi.fn();
  const { outbox } = makeOutbox({ sender });
  await outbox.enqueue({ roomId: 'r', workspaceId: 'w', body: 'private' });
  outbox.setOnline(true);
  await outbox.dispose();
  expect(sender).not.toHaveBeenCalled();
  await expect(outbox.enqueue({ roomId: 'r', workspaceId: 'w', body: 'late' })).rejects.toThrow('disposed');
});


it('TC-MSG-060 preserves reply target and attachments across restart and retry', async () => {
  const {cache, outbox} = makeOutbox();
  await outbox.enqueue({roomId:'room-1', workspaceId:'ws-1', body:'Reply', replyToMessageId:'original', attachments:[{local_path:'', attachment_id:'video', kind:'video', mime_type:'video/mp4', original_name:'clip.mp4', size_bytes:20}]});
  const restored = new Outbox(cache);
  await restored.restore();
  expect(restored.all()[0]?.reply_to_message_id).toBe('original');
  expect(restored.all()[0]?.attachments[0]?.attachment_id).toBe('video');
  await restored.dispose(); await outbox.dispose();
});
