import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_BOT_USERNAME } from '@banana-chat/shared';
import type { RoomListItem } from '@banana-chat/shared';
import { classifyDmError, findExistingDmRoomId, isAiBotUsername } from './profile-popup.js';

const user = (id: string) => ({ id, username: `u${id}`, display_name: `U ${id}`, avatar_attachment_id: null });
function item(roomId: string, type: string, other: string | null, secret = false): RoomListItem {
  return {
    room: { id: roomId, type, is_secret: secret } as unknown as RoomListItem['room'],
    my_role: 'member',
    other_user: other ? user(other) : null,
    last_message: null,
    unread_count: 0,
    muted: false,
  };
}

describe('findExistingDmRoomId', () => {
  it('TC-CORE-PROFPOP-001 returns the first DM with the user; ignores groups / null peer / undefined list', () => {
    const rooms = [item('g1', 'group', 'a'), item('d0', 'dm', null), item('d1', 'dm', 'a'), item('d2', 'dm', 'a')];
    expect(findExistingDmRoomId(rooms, 'a')).toBe('d1');
    expect(findExistingDmRoomId(rooms, 'zzz')).toBeNull();
    expect(findExistingDmRoomId(undefined, 'a')).toBeNull();
    expect(findExistingDmRoomId([], 'a')).toBeNull();
  });
  it('TC-CORE-PROFPOP-002 skips secret DMs', () => {
    expect(findExistingDmRoomId([item('s1', 'dm', 'a', true)], 'a')).toBeNull();
    expect(findExistingDmRoomId([item('s1', 'dm', 'a', true), item('d1', 'dm', 'a')], 'a')).toBe('d1');
  });
});

describe('classifyDmError', () => {
  it('TC-CORE-PROFPOP-003 maps status/code/network', () => {
    expect(classifyDmError({ status: 404, code: 'NOT_FOUND' })).toBe('unavailable');
    expect(classifyDmError({ status: 422, code: 'ROOM_DM_SELF' })).toBe('self');
    expect(classifyDmError({ status: 422, code: 'VALIDATION_FAILED' })).toBe('generic');
    expect(classifyDmError({ status: 403, code: 'FORBIDDEN' })).toBe('forbidden');
    expect(classifyDmError({ name: 'NetworkError' })).toBe('network');
    expect(classifyDmError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyDmError({ status: 429 })).toBe('generic');
    expect(classifyDmError({ status: 500 })).toBe('generic');
    expect(classifyDmError(new Error('x'))).toBe('generic');
    expect(classifyDmError(null)).toBe('generic');
    expect(classifyDmError('boom')).toBe('generic');
  });
});

describe('isAiBotUsername', () => {
  it('TC-CORE-PROFPOP-004 matches only the reserved bot username', () => {
    expect(AI_BOT_USERNAME).toBe('__banana_ai_bot__');
    expect(isAiBotUsername('__banana_ai_bot__')).toBe(true);
    expect(isAiBotUsername('alice')).toBe(false);
    expect(isAiBotUsername(undefined)).toBe(false);
  });
});

describe('profile.* i18n parity', () => {
  it('TC-CORE-PROFPOP-005 th and en carry the same profile.* keys', () => {
    const load = (l: string) =>
      JSON.parse(readFileSync(new URL(`../../shared/i18n/${l}.json`, import.meta.url), 'utf8')) as Record<string, string>;
    const keys = (d: Record<string, string>) => Object.keys(d).filter((k) => k.startsWith('profile.')).sort();
    const th = keys(load('th'));
    expect(th.length).toBeGreaterThanOrEqual(13);
    expect(th).toEqual(keys(load('en')));
  });
});
