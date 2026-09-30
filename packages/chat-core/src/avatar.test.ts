import { describe, expect, it } from 'vitest';
import type { Message, UserStub } from '@banana-chat/shared';
import {
  AVATAR_MAX_BYTES, AVATAR_MAX_ZOOM, avatarSource, checkAvatarFile, clampCrop, cropOutputSize,
  cropSourceRect, panCrop, parseParticipantAvatar, zoomCrop,
} from './avatar.js';
import { MessageStore } from './message-store.js';

describe('FR-PROF-006 avatar file rules', () => {
  it('TC-CORE-AVATAR-001 accepts jpeg/png/webp/gif up to 5 MB and marks only GIF animated', () => {
    expect(checkAvatarFile({ type: 'image/png', size: 10 })).toEqual({ ok: true, mime: 'image/png', animated: false });
    expect(checkAvatarFile({ type: 'image/gif', size: AVATAR_MAX_BYTES })).toEqual({ ok: true, mime: 'image/gif', animated: true });
    expect(checkAvatarFile({ type: 'IMAGE/JPEG', size: 1 })).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(checkAvatarFile({ type: 'image/webp', size: 1 })).toMatchObject({ ok: true });
  });

  it('TC-CORE-AVATAR-002 refuses other types before size, oversize and empty files', () => {
    expect(checkAvatarFile({ type: 'image/svg+xml', size: 10 })).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatarFile({ type: 'image/heic', size: 10 })).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatarFile({ type: 'application/pdf', size: AVATAR_MAX_BYTES * 8 })).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES + 1 })).toEqual({ ok: false, reason: 'size' });
    expect(checkAvatarFile({ type: 'image/png', size: 0 })).toEqual({ ok: false, reason: 'empty' });
  });

  it('TC-CORE-AVATAR-003 falls back to the extension only when the type is missing', () => {
    expect(checkAvatarFile({ type: '', size: 5, name: 'Me.JPG' })).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(checkAvatarFile({ type: '', size: 5, name: 'party.gif ' })).toMatchObject({ ok: true, animated: true });
    expect(checkAvatarFile({ type: '', size: 5, name: 'notes.txt' })).toEqual({ ok: false, reason: 'type' });
    expect(checkAvatarFile({ type: 'text/html', size: 5, name: 'photo.png' })).toEqual({ ok: false, reason: 'type' });
  });

  it('TC-CORE-AVATAR-004 renders animated only without reduced motion, md only when large', () => {
    const still = { sm: 'sm.webp', md: 'md.webp', animated: null };
    const gif = { sm: 'sm.webp', md: 'md.webp', animated: 'a.gif' };
    expect(avatarSource(null)).toBeNull();
    expect(avatarSource(undefined)).toBeNull();
    expect(avatarSource(still)).toBe('sm.webp');
    expect(avatarSource(still, { large: true })).toBe('md.webp');
    expect(avatarSource(gif)).toBe('a.gif');
    expect(avatarSource(gif, { reducedMotion: true })).toBe('sm.webp');
    expect(avatarSource(gif, { reducedMotion: true, large: true })).toBe('md.webp');
  });
});

describe('FR-PROF-006 square crop math', () => {
  const landscape = { width: 2000, height: 1000 };
  const box = 200;

  it('TC-CORE-AVATAR-005 zoom 1 centred crop is the centre square of the short edge', () => {
    expect(cropSourceRect(landscape, box, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 500, sy: 0, size: 1000 });
    expect(cropSourceRect({ width: 600, height: 900 }, box, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 0, sy: 150, size: 600 });
  });

  it('TC-CORE-AVATAR-006 panning is clamped so the image always covers the circle', () => {
    // at zoom 1 the displayed image is 400x200: 100px of slack each side horizontally, none vertically
    expect(clampCrop(landscape, box, { zoom: 1, x: 500, y: 40 })).toEqual({ zoom: 1, x: 100, y: 0 });
    expect(cropSourceRect(landscape, box, { zoom: 1, x: 100, y: 0 })).toEqual({ sx: 0, sy: 0, size: 1000 });
    expect(cropSourceRect(landscape, box, { zoom: 1, x: -100, y: 0 })).toEqual({ sx: 1000, sy: 0, size: 1000 });
    expect(panCrop(landscape, box, { zoom: 1, x: 90, y: 0 }, 50, 50)).toEqual({ zoom: 1, x: 100, y: 0 });
  });

  it('TC-CORE-AVATAR-007 zoom stays within bounds and keeps the centre point', () => {
    const zoomed = zoomCrop(landscape, box, { zoom: 1, x: 50, y: 0 }, 2);
    expect(zoomed).toEqual({ zoom: 2, x: 100, y: 0 });
    // source centre is the same pixel before and after
    const centre = (r: { sx: number; size: number }) => r.sx + r.size / 2;
    expect(centre(cropSourceRect(landscape, box, zoomed))).toBeCloseTo(centre(cropSourceRect(landscape, box, { zoom: 1, x: 50, y: 0 })));
    expect(zoomCrop(landscape, box, zoomed, 99).zoom).toBe(AVATAR_MAX_ZOOM);
    expect(zoomCrop(landscape, box, zoomed, 0.2)).toEqual({ zoom: 1, x: 50, y: 0 });
    expect(clampCrop(landscape, box, { zoom: Number.NaN, x: Number.NaN, y: 3 })).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it('TC-CORE-AVATAR-008 output never upscales and never exceeds 1024px', () => {
    expect(cropOutputSize(1000)).toBe(1000);
    expect(cropOutputSize(3000)).toBe(1024);
    expect(cropOutputSize(120.4)).toBe(120);
    expect(cropOutputSize(0.2)).toBe(1);
    const rect = cropSourceRect({ width: 4000, height: 3000 }, 300, { zoom: 4, x: 0, y: 0 });
    expect(rect.size).toBe(750);
    expect(rect.sx + rect.size).toBeLessThanOrEqual(4000);
  });
});

describe('FR-PROF-006 / EVT-087 sender refresh', () => {
  const alice: UserStub = { id: 'u-a', username: 'alice', display_name: 'Alice', avatar_attachment_id: null, avatar: null };
  const bob: UserStub = { id: 'u-b', username: 'bob', display_name: 'Bob', avatar_attachment_id: null };
  const msg = (seq: number, sender: UserStub): Message => ({
    id: `m${seq}`, room_id: 'r', workspace_id: 'w', sender_id: sender.id, sender, type: 'text', body: String(seq), seq,
    client_message_id: null, reply_to: null, system_event: null, edited_at: null, edit_count: 0, deleted_at: null,
    delete_reason: null, created_at: '2026-09-30T00:00:00Z', mentions: [], attachments: [],
  });

  it('TC-CORE-AVATAR-009 re-stamps every loaded row by that sender and emits only on change', () => {
    const emitted: number[] = [];
    const store = new MessageStore('r', 10_000, (s) => emitted.push(s.messages.length));
    store.replace([msg(1, alice), msg(2, bob), msg(3, alice)]);
    emitted.length = 0;
    const photo = { sm: 's', md: 'm', animated: null };
    store.updateSenders([{ ...alice, avatar_attachment_id: 'att', avatar: photo }]);
    const rows = store.getState().messages;
    expect(rows.map((m) => m.sender?.avatar ?? null)).toEqual([photo, null, photo]);
    expect(rows[1]!.sender).toBe(bob);
    expect(emitted).toEqual([3]);
    // same stub again: no emit, no new array
    const before = store.getState();
    store.updateSenders([{ ...alice, avatar_attachment_id: 'att', avatar: { ...photo } }, null]);
    expect(store.getState()).toBe(before);
    expect(emitted).toEqual([3]);
  });
});

describe('FR-PROF-007 / DEC-089 call participant metadata', () => {
  const still = { sm: 'https://cdn.test/a-sm.webp?e=1', md: 'https://cdn.test/a-md.webp?e=1', animated: null };
  const meta = (value: unknown) => JSON.stringify(value);

  it('TC-CORE-AVATAR-010 reads the avatar object from LiveKit participant metadata', () => {
    expect(parseParticipantAvatar(meta({ avatar: still }))).toEqual(still);
    const gif = { ...still, animated: 'http://127.0.0.1:5180/a.gif' };
    expect(parseParticipantAvatar(meta({ avatar: gif }))).toEqual(gif);
    // Extra keys are ignored, missing `animated` normalises to null.
    expect(parseParticipantAvatar(meta({ avatar: { sm: still.sm, md: still.md, extra: 1 }, other: true }))).toEqual(still);
  });

  it('TC-CORE-AVATAR-011 guests, missing and malformed metadata give null and never throw', () => {
    for (const bad of [undefined, null, '', '{', 'null', '[]', '"x"', '42', meta({}), meta({ avatar: null }), meta({ avatar: [] }),
      meta({ avatar: 'https://cdn.test/a.webp' }), meta({ avatar: { sm: still.sm } }), meta({ avatar: { sm: 1, md: 2 } })]) {
      expect(parseParticipantAvatar(bad as string | undefined)).toBeNull();
    }
  });

  it('TC-CORE-AVATAR-012 only absolute http(s) URLs are accepted', () => {
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/relative.webp', 'ftp://cdn.test/a.webp', 'not a url', 'x'.repeat(5000)]) {
      expect(parseParticipantAvatar(meta({ avatar: { ...still, sm: url } }))).toBeNull();
      expect(parseParticipantAvatar(meta({ avatar: { ...still, md: url } }))).toBeNull();
    }
    // A bad animated URL drops only the animation, the still still renders.
    expect(parseParticipantAvatar(meta({ avatar: { ...still, animated: 'javascript:alert(1)' } }))).toEqual(still);
  });
});
