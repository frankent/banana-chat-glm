import { describe, expect, it } from 'vitest';
import { roomListTime, roomPreviewText } from './room-list-presentation.js';
import type { RoomListItem } from '@banana-chat/shared';

// Built from local wall-clock components (not a hardcoded UTC offset) so the
// suite passes under any CI/runner timezone — roomListTime formats in the
// caller's local timezone, same convention as the rest of the app.
const NOW = new Date(2026, 8, 19, 15, 0, 0).getTime();
function local(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month, day, hour, minute).toISOString();
}

describe('roomListTime (FR-UI-CL-003)', () => {
  it('shows HH:mm for a message from today', () => {
    expect(roomListTime(local(2026, 8, 19, 8, 30), 'en-GB', NOW).short).toBe('08:30');
  });

  it('shows เมื่อวาน for yesterday', () => {
    expect(roomListTime(local(2026, 8, 18, 23, 0), 'th-TH', NOW).short).toBe('เมื่อวาน');
  });

  it('shows the weekday name within the last 7 days', () => {
    const result = roomListTime(local(2026, 8, 15, 9, 0), 'en-GB', NOW).short;
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('เมื่อวาน');
    expect(/\d/.test(result)).toBe(false);
  });

  it('shows d MMM without a year when the year matches', () => {
    expect(roomListTime(local(2026, 8, 1, 9, 0), 'en-GB', NOW).short).not.toMatch(/2026/);
  });

  it('shows d MMM yyyy when the year differs', () => {
    expect(roomListTime(local(2025, 8, 1, 9, 0), 'en-GB', NOW).short).toMatch(/2025/);
  });

  it('always returns a full accessible label', () => {
    expect(roomListTime(local(2026, 8, 19, 8, 30), 'en-GB', NOW).full.length).toBeGreaterThan(0);
  });
});

function stub(overrides: Partial<NonNullable<RoomListItem['last_message']>> = {}): RoomListItem['last_message'] {
  return { id: 'm1', type: 'text', body: 'hello', sender_id: 'user-2', created_at: local(2026, 8, 19, 8, 0), ...overrides };
}

describe('roomPreviewText (FR-UI-CL-002)', () => {
  it('returns ยังไม่มีข้อความ when there is no last message', () => {
    expect(roomPreviewText(null, 'user-1')).toBe('ยังไม่มีข้อความ');
  });

  it('prefixes our own message with คุณ:', () => {
    expect(roomPreviewText(stub({ sender_id: 'user-1', body: 'hi there' }), 'user-1')).toBe('คุณ: hi there');
  });

  it('does not prefix someone else’s message', () => {
    expect(roomPreviewText(stub({ sender_id: 'user-2', body: 'hi there' }), 'user-1')).toBe('hi there');
  });

  it('strips markdown syntax from the preview', () => {
    expect(roomPreviewText(stub({ body: '**bold** and `code` and [a link](https://x)' }), 'user-1')).toBe('bold and code and a link');
  });

  it('falls back to a typed label for an attachment-only image message', () => {
    expect(roomPreviewText(stub({ type: 'image', body: null }), 'user-1')).toBe('รูปภาพ');
  });

  it('falls back to a typed label for an attachment-only video message', () => {
    expect(roomPreviewText(stub({ type: 'video', body: null }), 'user-1')).toBe('วิดีโอ');
  });

  it('falls back to a typed label for an attachment-only file message', () => {
    expect(roomPreviewText(stub({ type: 'file', body: null }), 'user-1')).toBe('ไฟล์');
  });

  it('prefixes an attachment fallback for our own upload', () => {
    expect(roomPreviewText(stub({ type: 'image', body: null, sender_id: 'user-1' }), 'user-1')).toBe('คุณ: รูปภาพ');
  });

  it('renders system messages without a คุณ: prefix', () => {
    expect(roomPreviewText(stub({ type: 'system', sender_id: 'user-1', body: 'created the room' }), 'user-1')).toBe('created the room');
  });

  it('never uses a bare ellipsis to mean "attachment"', () => {
    const result = roomPreviewText(stub({ type: 'file', body: null }), 'user-1');
    expect(result).not.toBe('…');
  });
});
