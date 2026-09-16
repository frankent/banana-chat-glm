/**
 * FR-PCHAT-004/005 · API-220 — the support queue.
 *
 * SEPARATE FROM THE NORMAL ROOM LIST BY CONSTRUCTION: a public chat room is not
 * a `rooms` row (DEC-064), so it is absent from `useRooms()` and cannot be
 * reached from `RoomList`. This page follows the BoardPage filter pattern, not
 * RoomList's — RoomList is flat, membership-scoped and unfilterable.
 *
 * EVERY FILTER IS SERVER-SIDE (FR-PCHAT-004). The filter values are part of the
 * react-query key and are handed to API-220; a page that was already fetched is
 * never filtered in memory, or "Problem only" would silently mean "problem
 * rooms that happened to be on page 1".
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PUBLIC_CHAT_STATUSES, needsReply, publicChatStatusLabelKey } from '@banana-chat/chat-core';
import { t } from '@banana-chat/shared';
import type { PublicChatStatus, UserStub } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { pchat, pchatRelative } from '../lib/public-chat';
import type { PcListFilters, PcStaffRoom } from '../lib/public-chat';
import { useSession } from '../state/session';
import { Avatar, Icon } from '../components/Visual';
import { PcStatusPill } from '../components/PublicChatParts';
import './public-chat.css';

const en = (key: string) => t(key, 'en');

export function PublicChatListPage() {
  const { currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug ?? '';
  const navigate = useNavigate();

  const [status, setStatus] = useState<PublicChatStatus[]>([]);
  const [assignee, setAssignee] = useState<PcListFilters['assignee']>('all');
  const [q, setQ] = useState('');
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);

  const filters: PcListFilters = useMemo(
    () => ({ status, assignee, q, needsReply: needsReplyOnly }),
    [status, assignee, q, needsReplyOnly],
  );

  const rooms = useInfiniteQuery({
    // the filter values ARE the cache identity — see the file docblock
    queryKey: ['public-chat', 'rooms', slug, status, assignee, q, needsReplyOnly],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => pchat.rooms(slug, filters, pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: slug !== '',
    // EVT-080 message.created only reaches the room channels, so a new customer
    // message does not move `needs_reply`/`unread_count` in this list by itself.
    // EVT-081/082 on private-workspace invalidate it; this is the safety net.
    refetchInterval: 20_000,
  });

  const summary = useQuery({
    queryKey: ['public-chat', 'summary', slug],
    queryFn: () => pchat.summary(slug),
    enabled: slug !== '',
    refetchInterval: 30_000,
  });

  /** Assignee <select> options — active members of this workspace (API-030). */
  const members = useQuery({
    queryKey: ['public-chat', 'members', slug],
    queryFn: () => endpoints.directory('', slug),
    enabled: slug !== '',
    staleTime: 60_000,
  });

  const rows: PcStaffRoom[] = rooms.data?.pages.flatMap((page) => page.rooms) ?? [];
  const featureOff = summary.data !== undefined && !summary.data.feature_enabled;

  function toggleStatus(next: PublicChatStatus | null) {
    setStatus(next === null ? [] : [next]);
  }

  return (
    <div className="bc-pchat-queue">
      <header className="bc-pchat-queue-head">
        <div>
          <span className="bc-eyebrow">SUPPORT</span>
          <h1>
            {en('pchat.title')}
            <span>.</span>
          </h1>
          <p>Conversations customers started from a support link.</p>
        </div>
        {summary.data !== undefined && (
          <dl className="bc-pchat-summary" aria-label="Queue summary">
            <div>
              <dt>{en('pchat.status.new')}</dt>
              <dd>{summary.data.summary.new}</dd>
            </div>
            <div>
              <dt>{en('pchat.status.problem')}</dt>
              <dd>{summary.data.summary.problem}</dd>
            </div>
            <div>
              <dt>{en('pchat.filter.needsReply')}</dt>
              <dd>{summary.data.summary.needs_reply}</dd>
            </div>
            <div>
              <dt>{en('pchat.filter.assignee.me')}</dt>
              <dd>{summary.data.summary.mine}</dd>
            </div>
          </dl>
        )}
      </header>

      {featureOff && (
        <p className="bc-pchat-notice" role="status">
          <Icon name="lifebuoy" size={16} /> {en('pchat.paused')} — {en('pchat.banner.disabled')}
        </p>
      )}

      <div className="bc-pchat-toolbar">
        <div className="bc-pchat-segment" role="group" aria-label="Filter status">
          <button className={status.length === 0 ? 'selected' : ''} aria-pressed={status.length === 0} onClick={() => toggleStatus(null)}>
            {en('pchat.filter.statusAll')}
          </button>
          {PUBLIC_CHAT_STATUSES.map((value) => (
            <button
              key={value}
              className={status[0] === value ? 'selected' : ''}
              aria-pressed={status[0] === value}
              onClick={() => toggleStatus(status[0] === value ? null : value)}
            >
              {en(publicChatStatusLabelKey(value))}
            </button>
          ))}
        </div>

        <label className="bc-pchat-search">
          <Icon name="search" size={16} />
          <input
            aria-label={en('pchat.filter.search')}
            placeholder={en('pchat.filter.search')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>

        <select aria-label={en('pchat.room.assignee')} value={assignee} onChange={(event) => setAssignee(event.target.value)}>
          <option value="all">{en('pchat.filter.assignee.anyone')}</option>
          <option value="me">{en('pchat.filter.assignee.me')}</option>
          <option value="none">{en('pchat.filter.assignee.none')}</option>
          {(members.data ?? []).map((member: UserStub) => (
            <option key={member.id} value={member.id}>
              {member.display_name}
            </option>
          ))}
        </select>

        <button
          className={needsReplyOnly ? 'bc-pchat-toggle selected' : 'bc-pchat-toggle'}
          aria-pressed={needsReplyOnly}
          onClick={() => setNeedsReplyOnly(!needsReplyOnly)}
        >
          {en('pchat.filter.needsReply')}
        </button>
      </div>

      {rooms.isError && (
        <p role="alert" className="bc-pchat-alert">
          Could not load the support queue. <button onClick={() => void rooms.refetch()}>Retry</button>
        </p>
      )}
      {rooms.isPending && <p className="bc-caption">Loading support conversations…</p>}

      <ul className="bc-pchat-list">
        {rows.map((room) => (
          <li key={room.id}>
            <button className="bc-pchat-row" onClick={() => navigate(`/public-chat/${room.id}`)}>
              {/* customer_name and provider_name are partner-supplied: text nodes only (MANDATORY fix 20) */}
              <span className="bc-pchat-row-who">
                <strong>{room.customer_name}</strong>
                <small>{room.provider_name}</small>
                {room.external_ref !== null && <em>#{room.external_ref}</em>}
              </span>
              <PcStatusPill status={room.status} />
              <span className="bc-pchat-row-agent">
                {room.assigned_to === null ? (
                  <span className="bc-pchat-unassigned">{en('pchat.list.unassigned')}</span>
                ) : (
                  <>
                    <Avatar name={room.assigned_to.display_name} />
                    <span>{room.assigned_to.display_name}</span>
                  </>
                )}
              </span>
              <span className="bc-pchat-row-meta">
                {room.unread_count > 0 && <b>{room.unread_count}</b>}
                {needsReply(room) && <i className="bc-pchat-dot" title={en('pchat.list.needsReply')} aria-label={en('pchat.list.needsReply')} />}
                <time>{pchatRelative(room.last_message_at)}</time>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!rooms.isPending && rows.length === 0 && <p className="bc-pchat-empty">{en('pchat.list.empty')}</p>}

      {rooms.hasNextPage && (
        <button className="bc-pchat-more" disabled={rooms.isFetchingNextPage} onClick={() => void rooms.fetchNextPage()}>
          {rooms.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
