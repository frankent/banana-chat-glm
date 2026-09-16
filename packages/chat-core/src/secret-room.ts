/**
 * FR-ROOM-012 / DEC-056 — secret-room client logic, shared by web and mobile
 * (CLAUDE.md: platform-agnostic logic lives in chat-core). "Secret" means the
 * room expires: the server denies every read/write/media/call at
 * `secret_expires_at` and purges content through the retention scheduler.
 * It is NOT end-to-end encryption — UIs must present the backup limitation
 * alongside the expiry.
 */

/** Mirrors the server-side validation window (API-020, TC-ROOM-072). */
export const SECRET_EXPIRY_MIN_DAYS = 1;
export const SECRET_EXPIRY_MAX_DAYS = 30;

/** The wire shape every room payload shares (RoomListItem['room'], RoomDetail). */
export interface SecretRoomLike {
  is_secret?: boolean | null;
  secret_expires_at?: string | null;
}

export type SecretExpiryState =
  | { kind: 'ordinary' }
  | { kind: 'active'; expiresAt: string; msLeft: number }
  | { kind: 'expired'; expiresAt: string };

export function secretExpiryState(room: SecretRoomLike, now: number = Date.now()): SecretExpiryState {
  if (room.is_secret !== true || room.secret_expires_at == null) {
    return { kind: 'ordinary' };
  }
  const expiresAtMs = Date.parse(room.secret_expires_at);
  if (Number.isNaN(expiresAtMs)) {
    return { kind: 'ordinary' };
  }
  return expiresAtMs > now
    ? { kind: 'active', expiresAt: room.secret_expires_at, msLeft: expiresAtMs - now }
    : { kind: 'expired', expiresAt: room.secret_expires_at };
}

export function isSecretRoomActive(room: SecretRoomLike, now: number = Date.now()): boolean {
  return secretExpiryState(room, now).kind === 'active';
}

/**
 * Compact sidebar/header label, e.g. "🔒 3d" while active. Expired rooms
 * should not linger in lists (the server drops them), so expired labels are
 * only used by the eviction notice.
 */
export function secretExpiryShort(room: SecretRoomLike, now: number = Date.now()): string | null {
  const state = secretExpiryState(room, now);
  if (state.kind !== 'active') {
    return null;
  }
  const days = Math.max(1, Math.ceil(state.msLeft / 86_400_000));
  return `🔒 ${days}d`;
}

/** Locale-aware absolute expiry, e.g. "Sep 19, 14:30" — for headers/details. */
export function secretExpiryAbsolute(expiresAt: string, locale = 'en'): string {
  const date = new Date(expiresAt);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * FR-ROOM-012 (offline) — offline caches can hold a secret room past its
 * deadline (laptop asleep, no network, EVT never arrived). Room-list rows
 * carry the expiry metadata, so hydration filters on it BEFORE any cached
 * content is shown.
 */
export function filterExpiredRooms<T extends { room: SecretRoomLike & { id: string } }>(
  items: T[],
  now: number = Date.now(),
): { live: T[]; expiredRoomIds: string[] } {
  const live: T[] = [];
  const expiredRoomIds: string[] = [];
  for (const item of items) {
    if (secretExpiryState(item.room, now).kind === 'expired') {
      expiredRoomIds.push(item.room.id);
    } else {
      live.push(item);
    }
  }
  return { live, expiredRoomIds };
}

/**
 * Earliest live secret deadline in the set (ms since epoch), or null — the
 * offline watcher schedules one bounded timer at this instant instead of
 * polling; browsers clamp long sleeps by re-checking on visibility/pageshow.
 */
export function nextSecretDeadline<T extends { room: SecretRoomLike }>(items: T[], now: number = Date.now()): number | null {
  let earliest: number | null = null;
  for (const item of items) {
    const state = secretExpiryState(item.room, now);
    if (state.kind !== 'active') {
      continue;
    }
    const at = Date.parse(state.expiresAt);
    if (!Number.isNaN(at) && (earliest === null || at < earliest)) {
      earliest = at;
    }
  }
  return earliest;
}
