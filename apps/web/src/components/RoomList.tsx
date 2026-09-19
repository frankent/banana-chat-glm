import { useState } from 'react';
import { useRooms } from '../hooks/useRooms';
import type { RoomListItem } from '@banana-chat/shared';
import { roomListTime, roomPreviewText, secretExpiryShort } from '@banana-chat/chat-core';
import { NavLink } from 'react-router-dom';
import { Avatar, Icon } from './Visual';
import { NewRoomDialog } from './NewRoomDialog';
import { useSession } from '../state/session';

function roomTitle(item: RoomListItem): string {
  if (item.room.type === 'dm') {
    return item.other_user?.display_name ?? 'Direct message';
  }
  return item.room.name ?? 'Room';
}

/** FR-UI-CL-001/002/003/004 — two-line row: avatar, name+time, preview+badges. */
function RoomRow({ item, myUserId }: { item: RoomListItem; myUserId: string }) {
  // FR-ROOM-012 — remaining lifetime of a live secret room (null otherwise)
  const secretBadge = secretExpiryShort(item.room);
  const lastAt = item.last_message?.created_at ?? item.room.last_message_at;
  const time = lastAt !== null ? roomListTime(lastAt) : null;
  const unread = item.unread_count > 99 ? '99+' : item.unread_count > 0 ? String(item.unread_count) : null;

  return (
    <NavLink to={`/rooms/${item.room.id}`} className={({ isActive }) => `bc-room-row ${isActive ? 'selected' : ''}`}>
      <span className="bc-room-avatar" aria-hidden="true">
        {item.room.type === 'dm' ? <Avatar name={roomTitle(item)} /> : <span className="bc-room-hash">#</span>}
      </span>
      <span className="bc-room-main">
        <span className="bc-room-line1">
          <span className={`bc-room-name ${unread !== null ? 'unread' : ''}`}>{roomTitle(item)}</span>
          {time !== null && (
            <time className="bc-room-time" dateTime={lastAt ?? undefined} title={time.full}>
              {time.short}
            </time>
          )}
        </span>
        <span className="bc-room-line2">
          <span className="bc-room-preview">{roomPreviewText(item.last_message, myUserId)}</span>
          <span className="bc-room-badges">
            {item.muted && (
              <span className="bc-room-muted" title="Muted — notifications off for this room">
                <Icon name="mute" size={12} /> Muted
              </span>
            )}
            {secretBadge !== null && (
              <span className="bc-room-secret" title="Secret room — auto-deletes at expiry" data-testid="secret-room-badge">
                {secretBadge}
              </span>
            )}
            {unread !== null && <span className="bc-room-unread">{unread}</span>}
          </span>
        </span>
      </span>
    </NavLink>
  );
}

/** FR-UI-CL-007 — loading skeleton instead of a bare "Loading…" line. */
function RoomListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="bc-room-row bc-room-skeleton">
          <span className="bc-room-avatar bc-skel-circle" />
          <span className="bc-room-main">
            <span className="bc-skel-line" style={{ width: '55%' }} />
            <span className="bc-skel-line" style={{ width: '80%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** FR-UI-CL-005 — header keeps only workspace, "แชทใหม่", search and All/Unread. */
export function RoomList({ slug }: { slug: string }) {
  const me = useSession((s) => s.me);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const { data: rooms, isLoading, isError, refetch, isFetching } = useRooms(slug, filter);

  const noResults = rooms !== undefined && rooms.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="bc-new-room">
        <NewRoomDialog slug={slug} />
      </div>
      <div className="bc-room-filters" role="tablist" aria-label="Filter conversations">
        <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          All
        </button>
        <button role="tab" aria-selected={filter === 'unread'} className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>
          Unread
        </button>
      </div>
      <nav className="bc-room-list flex-1 overflow-y-auto">
        {isError ? (
          <p role="alert" className="px-3 py-2 text-sm text-red-600">
            Could not load conversations.{' '}
            <button disabled={isFetching} onClick={() => void refetch()} className="underline">
              Retry
            </button>
          </p>
        ) : isLoading ? (
          <RoomListSkeleton />
        ) : (
          <>
            {rooms?.map((item) => <RoomRow key={item.room.id} item={item} myUserId={me?.id ?? ''} />)}
            {noResults && filter === 'unread' && <p className="px-3 py-2 text-sm text-slate-400">No unread conversations.</p>}
            {noResults && filter === 'all' && <p className="px-3 py-2 text-sm text-slate-400">No conversations yet — start one above.</p>}
          </>
        )}
      </nav>
    </div>
  );
}
