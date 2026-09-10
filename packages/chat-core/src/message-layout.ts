import type { Message } from '@banana-chat/shared';
/** TASK-CORE-040: consecutive messages share an author label within five minutes. */
export function continuesMessage(previous: Message | undefined, current: Message): boolean {
  if (!previous || previous.type === 'system' || current.type === 'system' || previous.deleted_at || current.deleted_at) return false;
  const gap = Date.parse(current.created_at) - Date.parse(previous.created_at);
  return previous.sender_id === current.sender_id && previous.room_id === current.room_id && gap >= 0 && gap < 300000;
}
