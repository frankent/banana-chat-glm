import { useRooms } from '../hooks/useRooms';
import type { RoomListItem } from '@banana-chat/shared';
import { NavLink } from 'react-router-dom';
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
        `flex items-center justify-between rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-yellow-100 font-semibold' : 'hover:bg-slate-100'}`
      }
    >
      <span className="min-w-0">
        <span className="block truncate">
          {item.room.type === 'dm' ? '· ' : '# '}
          {roomTitle(item)}
        </span>
        {item.last_message !== null && (
          <span className="block truncate text-xs text-slate-400">{item.last_message.body ?? '…'}</span>
        )}
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
  const { data: rooms, isLoading } = useRooms(slug);

  return (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <NewRoomDialog slug={slug} />
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {isLoading && <p className="px-3 py-2 text-sm text-slate-400">Loading…</p>}
        {rooms?.map((item) => <RoomRow key={item.room.id} item={item} />)}
        {rooms !== undefined && rooms.length === 0 && (
          <p className="px-3 py-2 text-sm text-slate-400">No conversations yet — start one above.</p>
        )}
      </nav>
    </div>
  );
}
