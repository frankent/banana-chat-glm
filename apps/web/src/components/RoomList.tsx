import { useRooms } from '../hooks/useRooms';
import type { RoomListItem } from '@banana-chat/shared';
import { NavLink } from 'react-router-dom';
import { Avatar } from './Visual';
import { NewRoomDialog } from './NewRoomDialog';

function roomTitle(item: RoomListItem): string {
  if (item.room.type === 'dm') {
    return item.other_user?.display_name ?? 'Direct message';
  }
  return item.room.name ?? 'Room';
}

function RoomRow({ item }: { item: RoomListItem }) {
  return (
    <NavLink
      to={`/rooms/${item.room.id}`}
      className={({ isActive }) =>
        `bc-room-row ${isActive ? 'selected' : ''}`
      }
    >
      <span className="bc-room-content">
        {item.room.type === 'dm' ? <Avatar name={roomTitle(item)} /> : <span className="bc-room-hash" aria-hidden="true">#</span>}
        <span className="min-w-0 flex-1">
        <span className="block truncate">
          {roomTitle(item)}
        </span>
        {item.last_message !== null && (
          <span className="block truncate text-xs text-slate-400">{item.last_message.body ?? '…'}</span>
        )}
        </span>
      </span>
      {item.unread_count > 0 && (
        <span className="ml-2 shrink-0 rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-bold text-slate-900">
          {item.unread_count > 99 ? '99+' : item.unread_count}
        </span>
      )}
    </NavLink>
  );
}

export function RoomList({ slug }: { slug: string }) {
  const { data: rooms, isLoading, isError, refetch, isFetching } = useRooms(slug);

  return (
    <div className="flex h-full flex-col">
      <div className="bc-new-room">
        <NewRoomDialog slug={slug} />
      </div>
      <nav className="bc-room-list flex-1 overflow-y-auto">
        <p className="bc-list-label">RECENT CONVERSATIONS</p>
        {isError && <p role="alert" className="px-3 py-2 text-sm text-red-600">Could not load conversations. <button disabled={isFetching} onClick={() => void refetch()} className="underline">Retry</button></p>}
        {isLoading && <p className="px-3 py-2 text-sm text-slate-400">Loading…</p>}
        {rooms?.map((item) => <RoomRow key={item.room.id} item={item} />)}
        {rooms !== undefined && rooms.length === 0 && (
          <p className="px-3 py-2 text-sm text-slate-400">No conversations yet — start one above.</p>
        )}
      </nav>
    </div>
  );
}
