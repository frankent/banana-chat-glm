import type { RoomListItem } from '@banana-chat/shared';

/**
 * TASK-CORE-004 — badge math per FR-MSG-007/FR-WS-004: unread excludes muted
 * rooms; total is the sum, room count is how many rooms have any.
 */
export function unreadTotals(rooms: RoomListItem[]): { unreadRooms: number; totalUnread: number } {
  let unreadRooms = 0;
  let totalUnread = 0;
  for (const item of rooms) {
    if (item.muted || item.unread_count <= 0) {
      continue;
    }
    unreadRooms += 1;
    totalUnread += item.unread_count;
  }
  return { unreadRooms, totalUnread };
}

/**
 * FR-READ-003 — read-status reduction: who has read up to the message's seq.
 */
export function readersAt(
  readBy: { user_id: string; last_read_seq: number }[],
  seq: number,
): string[] {
  return readBy.filter((entry) => entry.last_read_seq >= seq).map((entry) => entry.user_id);
}
