import { describe, expect, it } from 'vitest';
import {
  SECRET_EXPIRY_MAX_DAYS,
  SECRET_EXPIRY_MIN_DAYS,
  filterExpiredRooms,
  isSecretRoomActive,
  nextSecretDeadline,
  secretExpiryShort,
  secretExpiryState,
  type SecretRoomLike,
} from '../src/secret-room.js';

/**
 * TC-ROOM-070/073 (client half) / FR-ROOM-012 — secret-room label + expiry
 * logic shared by web and mobile.
 */

const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('secretExpiryState', () => {
  it('ordinary and legacy rooms (field absent) classify as ordinary', () => {
    expect(secretExpiryState({}, NOW)).toEqual({ kind: 'ordinary' });
    expect(secretExpiryState({ is_secret: false, secret_expires_at: null }, NOW)).toEqual({ kind: 'ordinary' });
    expect(secretExpiryState({ is_secret: true, secret_expires_at: null }, NOW)).toEqual({ kind: 'ordinary' });
  });

  it('active before the deadline, expired at and after it (server boundary parity)', () => {
    const expiresAt = '2026-09-23T12:00:00Z'; // +7 days
    expect(secretExpiryState({ is_secret: true, secret_expires_at: expiresAt }, NOW - 1000))
      .toEqual({ kind: 'active', expiresAt, msLeft: 7 * 86_400_000 + 1000 });
    expect(secretExpiryState({ is_secret: true, secret_expires_at: expiresAt }, NOW + 7 * 86_400_000))
      .toEqual({ kind: 'expired', expiresAt });
  });

  it('unparseable timestamps degrade to ordinary instead of throwing', () => {
    expect(secretExpiryState({ is_secret: true, secret_expires_at: 'not-a-date' }, NOW)).toEqual({ kind: 'ordinary' });
  });
});

describe('isSecretRoomActive', () => {
  it('tracks the expiry state', () => {
    expect(isSecretRoomActive({ is_secret: true, secret_expires_at: '2026-09-17T12:00:00Z' }, NOW)).toBe(true);
    expect(isSecretRoomActive({ is_secret: true, secret_expires_at: '2026-09-15T12:00:00Z' }, NOW)).toBe(false);
    expect(isSecretRoomActive({}, NOW)).toBe(false);
  });
});

describe('secretExpiryShort', () => {
  it('labels active secret rooms with whole days, minimum 1', () => {
    const room = { is_secret: true as const, secret_expires_at: '2026-09-19T13:00:00Z' }; // ~3d1h
    expect(secretExpiryShort(room, NOW)).toBe('🔒 4d');
    expect(secretExpiryShort({ is_secret: true, secret_expires_at: '2026-09-16T12:20:00Z' }, NOW)).toBe('🔒 1d');
  });

  it('returns null for ordinary and expired rooms', () => {
    expect(secretExpiryShort({}, NOW)).toBeNull();
    expect(secretExpiryShort({ is_secret: true, secret_expires_at: '2026-09-15T00:00:00Z' }, NOW)).toBeNull();
  });
});

describe('expiry window constants', () => {
  it('mirrors the server validation window 1..30 days (TC-ROOM-072)', () => {
    expect(SECRET_EXPIRY_MIN_DAYS).toBe(1);
    expect(SECRET_EXPIRY_MAX_DAYS).toBe(30);
  });
});

describe('offline hydration — filterExpiredRooms / nextSecretDeadline', () => {
  // Room rows carry the expiry metadata alongside the id (RoomListItem['room']).
  // The annotation is what real callers pass; a bare `{ id }` literal has no
  // property in common with the all-optional SecretRoomLike and trips TS's
  // weak-type check even though a legacy room genuinely lacks the fields.
  type RoomRow = { room: SecretRoomLike & { id: string } };
  const ordinary: RoomRow = { room: { id: 'plain' } };
  const live: RoomRow = { room: { id: 'live', is_secret: true, secret_expires_at: '2026-09-17T12:00:00Z' } };
  const dead: RoomRow = { room: { id: 'dead', is_secret: true, secret_expires_at: '2026-09-16T11:59:59Z' } };

  it('splits cached room lists into live rows and expired ids (no network needed)', () => {
    const { live: kept, expiredRoomIds } = filterExpiredRooms([ordinary, live, dead], NOW);
    expect(kept.map((i) => i.room.id)).toEqual(['plain', 'live']);
    expect(expiredRoomIds).toEqual(['dead']);
  });

  it('returns the earliest live deadline for the bounded wake-up timer', () => {
    const later: RoomRow = { room: { id: 'later', is_secret: true, secret_expires_at: '2026-09-20T00:00:00Z' } };
    expect(nextSecretDeadline([ordinary, live, later, dead], NOW)).toBe(Date.parse('2026-09-17T12:00:00Z'));
    expect(nextSecretDeadline([ordinary, dead], NOW)).toBeNull();
  });
});
