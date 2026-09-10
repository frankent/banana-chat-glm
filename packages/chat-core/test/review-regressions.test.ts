import { afterEach, expect, it, vi } from 'vitest';
import { MessageStore, RoomSync, ReadReceiptReporter, applyRoomEvent, uploadTicket } from '../src/index.js';
import type { Message, UploadTicket } from '@banana-chat/shared';
const msg = (seq: number, overrides: Partial<Message> = {}): Message => ({ id: `m${seq}`, seq, room_id: 'r', workspace_id: 'w', sender_id: 'u', sender: null, type: 'text', body: `body ${seq}`, client_message_id: null, reply_to: null, system_event: null, edited_at: null, edit_count: 0, deleted_at: null, delete_reason: null, created_at: '2026-01-01T00:00:00Z', mentions: [], attachments: [], ...overrides });
afterEach(() => vi.useRealTimers());
it('TC-CORE-013 reconnect fills multiple pages and applies missed edits and deletes', async () => {
  const store = new MessageStore('r');
  store.replace([msg(1), msg(2)]);
  const fetch = vi.fn().mockResolvedValueOnce({ messages: [msg(1, { body: 'edited', edit_count: 1 }), msg(2, { body: null, deleted_at: '2026-01-02T00:00:00Z' })], has_more_after: true }).mockResolvedValueOnce({ messages: [msg(3)], has_more_after: false });
  const sync = new RoomSync(store, fetch);
  await Promise.all([sync.refresh(), sync.refresh()]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(call => call[0].after_seq)).toEqual([0, 2]);
  expect(store.getState().messages.map(m => m.body)).toEqual(['edited', null, 'body 3']);
  store.dispose();
});
it('TC-CORE-014 a late history page cannot resurrect a deleted or older edited message', () => {
  const store = new MessageStore('r');
  store.replace([msg(1)]);
  applyRoomEvent(store, 'message.updated', { message: msg(1, { edit_count: 2, body: 'new' }) });
  store.mergePage([msg(1)]);
  expect(store.getState().messages[0].body).toBe('new');
  applyRoomEvent(store, 'message.deleted', { message_id: 'm1' });
  store.mergePage([msg(1)]);
  expect(store.getState().messages[0].deleted_at).not.toBeNull();
  store.dispose();
});
it('TC-READ-001 sends highest visible seq once per second and cancels after blur/unmount', async () => {
  vi.useFakeTimers();
  let visible = true;
  const send = vi.fn().mockResolvedValue(undefined);
  const reporter = new ReadReceiptReporter(send, () => visible);
  reporter.observe(1); reporter.observe(2); reporter.observe(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(send.mock.calls).toEqual([[3]]);
  reporter.observe(4); visible = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(1);
  visible = true; reporter.observe(4); reporter.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(1);
});
const ticket: UploadTicket = { attachment_id: 'a', put_url: null, headers: {}, expires_at: '', multipart: { upload_id: 'm', part_size: 5, part_urls: ['p1', 'p2', 'p3'] } };
it('TC-MEDIA-010 multipart sends exact byte slices and ordered ETags, including final short part', async () => {
  const put = vi.fn(async (url: string) => `etag-${url}`);
  expect(await uploadTicket(ticket, 12, put)).toEqual([{ part_number: 1, etag: 'etag-p1' }, { part_number: 2, etag: 'etag-p2' }, { part_number: 3, etag: 'etag-p3' }]);
  expect(put.mock.calls).toEqual([['p1', {}, 0, 5], ['p2', {}, 5, 10], ['p3', {}, 10, 12]]);
});
it('TC-MEDIA-010 missing ETag prevents complete; single PUT requires no ETag', async () => {
  await expect(uploadTicket(ticket, 12, async () => null)).rejects.toThrow('ETag');
  expect(await uploadTicket({ ...ticket, multipart: null, put_url: 'single' }, 12, async () => null)).toBeUndefined();
});
