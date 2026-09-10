import { expect, it } from 'vitest';
import { continuesMessage, parseInline } from '../src/index.js';
import type { Message } from '@banana-chat/shared';
it('TC-WEB-041 groups adjacent authors but not different rooms or old messages', () => {
  const first = {sender_id:'a', room_id:'one', type:'text', deleted_at:null, created_at:'2026-09-11T00:00:00Z'} as Message;
  expect(continuesMessage(first, {...first, created_at:'2026-09-11T00:02:00Z'})).toBe(true);
  expect(continuesMessage(first, {...first, sender_id:'b'})).toBe(false);
  expect(continuesMessage(first, {...first, room_id:'two'})).toBe(false);
  expect(continuesMessage(first, {...first, created_at:'2026-09-11T00:06:00Z'})).toBe(false);
});
it('TC-MEDIA-020 link notes autolink HTTPS while rejecting executable Markdown links', () => {
  expect(parseInline('See https://example.com.')).toContainEqual({type:'link',href:'https://example.com',text:'https://example.com'});
  expect(parseInline('[bad](javascript:alert(1))').some(n => n.type === 'link')).toBe(false);
  expect(parseInline('`https://example.com`')).toEqual([{type:'code',text:'https://example.com'}]);
});
