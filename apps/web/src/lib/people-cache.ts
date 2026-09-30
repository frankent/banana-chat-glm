import type { QueryClient } from '@tanstack/react-query';

/**
 * FR-PROF-006 / EVT-087 — every cache that renders a member's name or photo.
 * A profile change (mine after PATCH /me, anyone's via `user.updated` on the
 * workspace channel) refetches all of them; the message refetch then
 * re-stamps older loaded rows through MessageStore.updateSenders.
 */
export function invalidatePeople(queryClient: QueryClient) {
  for (const key of ['directory', 'room-members', 'rooms', 'room', 'messages', 'read-status']) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
