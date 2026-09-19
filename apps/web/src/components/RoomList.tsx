import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { RoomListItem } from '@banana-chat/shared';
import { roomListTime, roomPreviewText, secretExpiryShort } from '@banana-chat/chat-core';
import { useRooms } from '../hooks/useRooms';
import { useSession } from '../state/session';
import { useChatText } from '../lib/use-chat-text';
import { Avatar, Icon } from './Visual';
import { NewRoomDialog } from './NewRoomDialog';

function roomTitle(item: RoomListItem) {
  return item.room.type === 'dm' ? item.other_user?.display_name ?? 'Direct message' : item.room.name ?? 'Room';
}
function RoomRow({ item, myUserId }: { item: RoomListItem; myUserId: string }) {
  const { text } = useChatText();
  const secretBadge = secretExpiryShort(item.room);
  const lastAt = item.last_message?.created_at ?? item.room.last_message_at;
  const time = lastAt ? roomListTime(lastAt) : null;
  const unread = item.unread_count > 0;
  return (
    <NavLink to={`/rooms/${item.room.id}`} className={({ isActive }) => `bc-room-row ${isActive ? 'selected' : ''}`} data-muted={item.muted}>
      <span className="bc-room-avatar"><Avatar name={roomTitle(item)} />{item.room.type !== 'dm' && <span className="bc-room-kind"><Icon name={item.room.is_secret ? 'lock' : 'users'} size={11} /></span>}</span>
      <span className="bc-room-main">
        <span className="bc-room-line1"><span className={`bc-room-name ${unread ? 'unread' : ''}`}>{roomTitle(item)}</span>{time && <time className="bc-room-time" dateTime={lastAt!} title={time.full}>{time.short}</time>}</span>
        <span className="bc-room-line2"><span className="bc-room-preview">{roomPreviewText(item.last_message, myUserId)}</span><span className="bc-room-badges">
          {item.muted && <span className="bc-room-muted" title={text('chat.muted')} aria-label={text('chat.muted')}><Icon name="mute" size={14} /></span>}
          {secretBadge && <span className="bc-room-secret" title="Secret room — auto-deletes at expiry; not end-to-end encrypted" data-testid="secret-room-badge"><Icon name="lock" size={11} />{secretBadge}</span>}
          {unread && <span className="bc-room-unread" aria-label={`${item.unread_count} ${text('chat.unread')}`}>{item.unread_count > 99 ? '99+' : item.unread_count}</span>}
        </span></span>
      </span>
    </NavLink>
  );
}

/** FR-UI-CL: retain cached navigation on errors; controls do not compete with rows. */
export function RoomList({ slug }: { slug: string }) {
  const me = useSession(s => s.me);
  const { text } = useChatText();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: rooms, isLoading, isError, refetch, isFetching } = useRooms(slug, filter);
  const shown = rooms?.filter(item => roomTitle(item).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <div className="bc-conversations">
      <div className="bc-conversations-title"><h1>{text('chat.title')}</h1><button className="bc-chat-control bc-new-chat" aria-label={text('chat.new')} aria-expanded={creating} onClick={() => setCreating(value => !value)}><Icon name="edit" size={19} /></button></div>
      {creating && <div className="bc-new-room"><NewRoomDialog slug={slug} /></div>}
      <label className="bc-chat-search"><Icon name="search" size={18} /><input aria-label={text('chat.search')} placeholder={text('chat.search')} value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="bc-chat-control" aria-label={text('chat.cancel')} onClick={() => setSearch('')}><Icon name="close" size={16} /></button>}</label>
      <div className="bc-room-filters" role="group" aria-label="Filter conversations">{(['all', 'unread'] as const).map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{text(`chat.${value}`)}</button>)}</div>
      <nav className="bc-room-list" aria-label={text('chat.title')}>
        {isError && <div role="alert" className="bc-list-error"><p>{text('chat.listError')}</p><button disabled={isFetching} onClick={() => void refetch()}>{text('chat.retry')}</button></div>}
        {isLoading && !rooms && <div aria-label={text('chat.loading')}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="bc-room-row bc-room-skeleton"><span className="bc-skel-circle" /><span className="bc-room-main"><span className="bc-skel-line" /><span className="bc-skel-line" /></span></div>)}</div>}
        {shown?.map(item => <RoomRow key={item.room.id} item={item} myUserId={me?.id ?? ''} />)}
        {shown?.length === 0 && <div className="bc-chat-list-empty"><Icon name={filter === 'unread' ? 'check' : 'chat'} size={28} /><strong>{search ? text('chat.noResults') : filter === 'unread' ? text('chat.caughtUp') : text('chat.empty')}</strong>{!search && filter === 'all' && <p>{text('chat.emptyHint')}</p>}</div>}
      </nav>
      {search && <button className="bc-search-all" onClick={() => navigate('/search')}>{text('chat.searchAll')}<Icon name="arrow" size={16} /></button>}
    </div>
  );
}
