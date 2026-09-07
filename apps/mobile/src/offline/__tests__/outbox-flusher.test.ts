import { describe, expect, it } from '@jest/globals';
import { ApiError } from '@banana-chat/api-client';
import { Endpoints } from '@banana-chat/api-client';
import { MemoryCacheAdapter, Outbox, type OutboxAttachmentDraft } from '@banana-chat/chat-core';
import type { Message } from '@banana-chat/shared';
import { createOutboxSender, ATTACHMENT_MISSING_ERROR } from '../outbox-flusher';

/**
 * TASK-MOB-005 — offline send flow (TC-MOB-009..014, Jest parts).
 */

function fakeEndpoints(overrides: Partial<Record<'sendMessage' | 'createUpload' | 'completeUpload', unknown>> = {}) {
  const calls: Record<string, unknown[]> = { sendMessage: [], createUpload: [], completeUpload: [] };
  const impl: Record<string, unknown> = {
    async sendMessage(roomId: string, slug: string, body: string | null, cmid: string, _reply?: unknown, attachmentIds: string[] = []) {
      calls.sendMessage.push({ roomId, slug, body, cmid, attachmentIds });
      return { message: { id: 'server-1', client_message_id: cmid } as unknown as Message };
    },
    async createUpload(slug: string, input: Record<string, unknown>) {
      calls.createUpload.push({ slug, input });
      return { attachment_id: `att-${calls.createUpload.length}`, put_url: 'https://s3/put', headers: {}, expires_at: '' };
    },
    async completeUpload(attachmentId: string, slug: string) {
      calls.completeUpload.push({ attachmentId, slug });
      return { attachment: {} };
    },
    ...overrides,
  };
  return { calls, impl: impl as unknown as Endpoints };
}

function confirmedMessage(cmid: string): Message {
  return {
    id: 'server-1',
    room_id: 'room-1',
    workspace_id: 'ws-1',
    sender_id: 'u1',
    sender: null,
    type: 'text',
    body: 'ok',
    seq: 10,
    client_message_id: cmid,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    mentions: [],
    attachments: [],
  };
}

function makeOutbox(senderImpl: Endpoints, existsPaths = new Set<string>(['/local/photo.jpg'])) {
  const cache = new MemoryCacheAdapter({ scope: { userId: 'u1', workspaceId: 'ws-1' } });
  const sender = createOutboxSender({
    endpoints: senderImpl,
    uploadFile: async (path) => {
      if (!existsPaths.has(path)) {
        throw new Error('ENOENT');
      }
      return 1024;
    },
    fileExists: async (path) => existsPaths.has(path),
  });
  const delivered: Array<{ cmid: string; message: Message }> = [];
  const outbox = new Outbox(cache, { sender, onDelivered: (entry, message) => delivered.push({ cmid: entry.client_message_id, message }) });
  return { outbox, delivered };
}

describe('outbox flusher', () => {
  it('TC-MOB-026/010 sends offline-queued messages in order with the original client_message_id', async () => {
    const { calls, impl } = fakeEndpoints();
    const { outbox } = makeOutbox(impl);

    const a = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'one', clientMessageId: 'cmid-1' });
    const b = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'two', clientMessageId: 'cmid-2' });
    expect(outbox.entriesForRoom('room-1').map((e) => e.id)).toEqual([a.id, b.id]);

    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.sendMessage.map((c) => (c as { cmid: string }).cmid)).toEqual(['cmid-1', 'cmid-2']);
    expect(outbox.all()).toHaveLength(0);
  });

  it('TC-MOB-013 uploads an offline attachment from its local path before sending', async () => {
    const { calls, impl } = fakeEndpoints();
    const { outbox } = makeOutbox(impl);

    const draft: OutboxAttachmentDraft[] = [
      { local_path: '/local/photo.jpg', kind: 'image', mime_type: 'image/jpeg', original_name: 'photo.jpg', size_bytes: 2048 },
    ];
    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: null, clientMessageId: 'cmid-att', attachments: draft });
    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.createUpload).toHaveLength(1);
    expect(calls.completeUpload).toHaveLength(1);
    expect((calls.sendMessage[0] as { attachmentIds: string[] }).attachmentIds).toEqual(['att-1']);
  });

  it('TC-MOB-014 a vanished local file fails permanently with a user-facing message', async () => {
    const { calls, impl } = fakeEndpoints();
    const { outbox } = makeOutbox(impl, new Set()); // nothing exists

    await outbox.enqueue({
      roomId: 'room-1',
      workspaceId: 'ws-1',
      body: 'gone',
      clientMessageId: 'cmid-gone',
      attachments: [{ local_path: '/local/gone.jpg', kind: 'image', mime_type: 'image/jpeg', original_name: 'gone.jpg', size_bytes: 10 }],
    });
    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.sendMessage).toHaveLength(0);
    const failed = outbox.all()[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.last_error).toBe(ATTACHMENT_MISSING_ERROR);
  });

  it('TC-MOB-028 a 4xx from the API fails the entry without retrying', async () => {
    const { impl } = fakeEndpoints({
      sendMessage: async () => {
        throw new ApiError(403, { code: 'FORBIDDEN', message: 'no longer a member', request_id: null });
      },
    });
    const { outbox } = makeOutbox(impl);

    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'x', clientMessageId: 'cmid-403' });
    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 20));

    expect(outbox.all()[0]?.status).toBe('failed');
    expect(outbox.all()[0]?.last_error).toContain('no longer a member');
  });

  it('TC-MOB-030 manual retry re-sends after the failure is cleared', async () => {
    let fail = true;
    const { impl } = fakeEndpoints({
      sendMessage: async (roomId: string, slug: string, body: string | null, cmid: string) => {
        if (fail) {
          throw new ApiError(422, { code: 'VALIDATION_FAILED', message: 'boom', request_id: null });
        }
        return { message: confirmedMessage(cmid) };
      },
    });
    const { outbox } = makeOutbox(impl);

    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'x', clientMessageId: 'cmid-retry' });
    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(outbox.all()[0]?.status).toBe('failed');

    fail = false;
    await outbox.retry(outbox.all()[0]!.id);
    await new Promise((r) => setTimeout(r, 10));
    expect(outbox.all()).toHaveLength(0);
  });

  it('TC-MOB-031 remove drops a pending entry before flush', async () => {
    const { calls, impl } = fakeEndpoints();
    const { outbox } = makeOutbox(impl);

    await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'keep', clientMessageId: 'cmid-keep' });
    const drop = await outbox.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'drop', clientMessageId: 'cmid-drop' });
    await outbox.remove(drop.id);
    outbox.setOnline(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.sendMessage).toHaveLength(1);
    expect((calls.sendMessage[0] as { cmid: string }).cmid).toBe('cmid-keep');
  });

  it('TC-MOB-011 the queue survives an app restart via the adapter', async () => {
    const { impl } = fakeEndpoints();
    const cache = new MemoryCacheAdapter({ scope: { userId: 'u1', workspaceId: 'ws-1' } });
    const first = new Outbox(cache);
    await first.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'persisted', clientMessageId: 'cmid-persist' });

    const revived = new Outbox(cache);
    await revived.restore();
    expect(revived.all().map((e) => e.client_message_id)).toEqual(['cmid-persist']);
    void impl;
  });
});

