import { describe, expect, it } from 'vitest';
import { EventRouter } from '../src/event-router.js';
import { backoffDelay, planSync } from '../src/sync.js';
import { readersAt, unreadTotals } from '../src/unread-calculator.js';
import type { RoomListItem } from '@banana-chat/shared';

function roomItem(id: string, unread: number, muted = false): RoomListItem {
  return {
    room: {
      id,
      workspace_id: 'w1',
      type: 'group',
      name: id,
      description: null,
      avatar_attachment_id: null,
      created_by: 'u1',
      last_seq: unread,
      member_count: 2,
      last_message_at: null,
    },
    my_role: 'member',
    other_user: null,
    last_message: null,
    unread_count: unread,
    muted,
  };
}

describe('TC-CORE-007 unread math (FR-MSG-007)', () => {
  it('sums unread and counts rooms, skipping muted', () => {
    const totals = unreadTotals([roomItem('a', 3), roomItem('b', 0), roomItem('c', 5, true), roomItem('d', 2)]);
    expect(totals).toEqual({ unreadRooms: 2, totalUnread: 5 });
  });
});

describe('TC-CORE-008 read-status reduction', () => {
  it('filters readers by seq', () => {
    const readers = readersAt(
      [
        { user_id: 'u1', last_read_seq: 10 },
        { user_id: 'u2', last_read_seq: 4 },
        { user_id: 'u3', last_read_seq: 5 },
      ],
      5,
    );
    expect(readers).toEqual(['u1', 'u3']);
  });
});

describe('TC-CORE-009 EventRouter', () => {
  it('dispatches by event name and supports unsubscribe', () => {
    const router = new EventRouter();
    const seen: string[] = [];
    const off = router.on<{ room_id: string }>('room.read', (data) => seen.push(data.room_id));

    router.dispatchRaw('room.read', { workspace_id: 'w1', data: { room_id: 'r1' }, emitted_at: 'now' });
    off();
    router.dispatchRaw('room.read', { workspace_id: 'w1', data: { room_id: 'r2' }, emitted_at: 'now' });

    expect(seen).toEqual(['r1']);
  });

  it('a throwing handler does not break other handlers', () => {
    const router = new EventRouter();
    const seen: number[] = [];
    router.on('room.read', () => {
      throw new Error('boom');
    });
    router.on('room.read', () => seen.push(1));

    router.dispatchRaw('room.read', { data: {} });
    expect(seen).toEqual([1]);
  });
});

describe('TC-CORE-010 sync planning', () => {
  it('returns rooms whose last_seq advanced', () => {
    const plan = planSync(
      [{ room: { id: 'a', last_seq: 3 } }, { room: { id: 'b', last_seq: 5 } }],
      [{ room: { id: 'a', last_seq: 3 } }, { room: { id: 'b', last_seq: 9 } }, { room: { id: 'c', last_seq: 1 } }],
    );
    expect(plan.changedRoomIds).toEqual(['b', 'c']);
  });
});

describe('TC-CORE-011 backoff', () => {
  it('grows exponentially with jitter, capped', () => {
    expect(backoffDelay(0, 100, 10_000)).toBeGreaterThanOrEqual(100);
    expect(backoffDelay(1, 100, 10_000)).toBeGreaterThanOrEqual(200);
    expect(backoffDelay(20, 100, 10_000)).toBeLessThanOrEqual(10_000);
  });
});
