/**
 * FR-PROF-009 / DEC-101 — avatar click -> profile popup -> "Chat 1-1".
 * Pure helpers shared by web (and a later mobile slice). No network, no DOM.
 */
import { AI_BOT_USERNAME } from '@banana-chat/shared';
import type { RoomListItem } from '@banana-chat/shared';

/** The AI bot sender is not a person: its avatar/name are never clickable. */
export function isAiBotUsername(username: string | undefined): boolean {
  return username === AI_BOT_USERNAME;
}

/**
 * The normal (non-secret) DM with `userId` in the cached room list, or null.
 * The list is recency-sorted so the first match wins. Secret DMs live in their
 * own namespace (FR-ROOM-001 / secret rooms) and are never reused here.
 */
export function findExistingDmRoomId(rooms: readonly RoomListItem[] | undefined, userId: string): string | null {
  if (!rooms) return null;
  for (const item of rooms) {
    const room = item.room;
    if (room.type === 'dm' && !room.is_secret && item.other_user?.id === userId) return room.id;
  }
  return null;
}

export type DmFailureKind = 'unavailable' | 'self' | 'forbidden' | 'network' | 'generic';

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  name?: unknown;
}

/**
 * Maps a failed `createDm` into the popup's message. Duck-typed on
 * `{status, code, name}` so chat-core need not import api-client.
 */
export function classifyDmError(error: unknown): DmFailureKind {
  if (error instanceof TypeError) return 'network';
  if (typeof error !== 'object' || error === null) return 'generic';
  const e = error as ErrorLike;
  if (e.name === 'NetworkError') return 'network';
  if (e.status === 404) return 'unavailable';
  if (e.status === 422 && e.code === 'ROOM_DM_SELF') return 'self';
  if (e.status === 403) return 'forbidden';
  return 'generic';
}
