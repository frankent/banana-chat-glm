import { describe, expect, it } from '@jest/globals';
import { ANDROID_CHANNELS, androidChannelFor, badgeNumber, parseDeepLink, roomDeepLink, shouldShowForegroundBanner } from '../routing';

/**
 * TASK-MOB-008 — push routing decisions (TC-MOB-031/032 link shape/033/034).
 */
describe('push routing', () => {
  it('TC-MOB-031 foreground banner shows only for pushes outside the open room', () => {
    const payload = { room_id: 'room-1', workspace_slug: 'acme' };
    expect(shouldShowForegroundBanner(payload, 'room-1')).toBe(false); // same room → suppressed
    expect(shouldShowForegroundBanner(payload, 'room-2')).toBe(true); // another room → banner
    expect(shouldShowForegroundBanner(payload, null)).toBe(true); // not in a room → banner
    expect(shouldShowForegroundBanner(null, null)).toBe(true); // no payload → banner
    expect(shouldShowForegroundBanner({ conversation_id: 'c1' }, null)).toBe(true); // ai → banner
  });

  it('TC-MOB-034 Android channel ids cover messages, mentions and AI', () => {
    expect(ANDROID_CHANNELS.map((c) => c.id).sort()).toEqual(['ai', 'mentions', 'messages']);
    expect(androidChannelFor({ room_id: 'r' })).toBe('messages');
    expect(androidChannelFor({ room_id: 'r', mention: true })).toBe('mentions');
    expect(androidChannelFor({ conversation_id: 'c' })).toBe('ai');
    expect(androidChannelFor(null)).toBe('messages');
  });

  it('TC-MOB-033 badge number clamps to a sane non-negative integer', () => {
    expect(badgeNumber(0)).toBe(0);
    expect(badgeNumber(12)).toBe(12);
    expect(badgeNumber(-3)).toBe(0);
    expect(badgeNumber(2.7)).toBe(2);
    expect(badgeNumber(1_000_000)).toBe(99_999);
  });

  it('TC-MOB-032 deep links round-trip room and ai targets', () => {
    const url = roomDeepLink('acme', 'room-9');
    expect(url).toBe('orgchat://room/acme/room-9');
    expect(parseDeepLink(url)).toEqual({ type: 'room', workspaceSlug: 'acme', roomId: 'room-9' });
    expect(parseDeepLink('orgchat://ai/conv-1')).toEqual({ type: 'ai', conversationId: 'conv-1' });
    expect(parseDeepLink('orgchat://room/only-slug')).toBeNull();
    expect(parseDeepLink('https://example.com/x')).toBeNull();
  });
});
