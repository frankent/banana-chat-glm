import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventEnvelope, Message } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useMessageStore, roomStore } from '../lib/room-stores';
import { useMessagePage } from '../hooks/useMessages';
import { useEcho } from '../echo/EchoProvider';
import { useSession } from '../state/session';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { RoomMediaPanel } from './RoomMediaPanel';

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ChatView() {
  const { roomId } = useParams<{ roomId: string }>();
  const { me, currentWorkspace } = useSession();
  const { echo } = useEcho();
  const queryClient = useQueryClient();
  const slug = currentWorkspace?.workspace.slug;
  const [searchParams, setSearchParams] = useSearchParams();
  // search jump-to-result (FR-SRCH-001): seed the page around the hit
  const aroundSeqParam = searchParams.get('around_seq');
  const aroundSeq = aroundSeqParam !== null ? Number(aroundSeqParam) : undefined;
  const { query, loadOlder, fillGap } = useMessagePage(roomId, slug, Number.isFinite(aroundSeq) ? aroundSeq : undefined);
  const state = useMessageStore(roomId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const jumpedRef = useRef<string | undefined>(undefined);
  const [mediaOpen, setMediaOpen] = useState(false);

  const roomQuery = useQuery({
    queryKey: ['room', roomId],
    queryFn: () => endpoints.room(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined,
    staleTime: 60_000,
  });

  // roster for @mention autocomplete (FR-MSG-008)
  const membersQuery = useQuery({
    queryKey: ['room-members', roomId],
    queryFn: () => endpoints.roomMembers(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined,
    staleTime: 60_000,
  });

  const readStatusQuery = useQuery({
    queryKey: ['read-status', roomId],
    queryFn: () => endpoints.readStatus(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined && roomQuery.data?.room.type === 'dm',
  });

  const markRead = (seq: number) => {
    if (roomId === undefined || slug === undefined || seq <= 0) {
      return;
    }
    void endpoints.markRead(roomId, slug, seq).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    });
  };

  // room channel: message.created + room.read (EVT-010/EVT-020)
  useEffect(() => {
    if (echo === null || roomId === undefined || slug === undefined || me === null) {
      return;
    }
    const channel = echo.private(`room.${roomId}`);
    const store = roomStore(roomId);

    const onMessage = (envelope: EventEnvelope<{ message: Message }>) => {
      const message = envelope.data?.message;
      if (message === undefined) {
        return;
      }
      store.add(message);
      if (message.sender_id !== me.id && document.visibilityState === 'visible') {
        markRead(message.seq);
      } else if (message.sender_id === me.id) {
        void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      }
    };

    const onRead = () => {
      void queryClient.invalidateQueries({ queryKey: ['read-status', roomId] });
      void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
    };

    // EVT-011 edit — merge by id (store.add)
    const onUpdated = (envelope: EventEnvelope<{ message: Message }>) => {
      const message = envelope.data?.message;
      if (message !== undefined) {
        store.add(message);
      }
    };

    // EVT-012 delete — tombstone keeps seq, drops body (FR-MSG-006)
    const onDeleted = (envelope: EventEnvelope<{ message_id: string; delete_reason: string | null }>) => {
      const data = envelope.data;
      if (data?.message_id !== undefined) {
        store.markDeleted(data.message_id, new Date().toISOString(), data.delete_reason ?? 'sender');
        void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      }
    };

    channel.listen('.message.created', onMessage).listen('.room.read', onRead)
      .listen('.message.updated', onUpdated)
      .listen('.message.deleted', onDeleted);
    return () => {
      channel.stopListening('.message.created');
      channel.stopListening('.room.read');
      channel.stopListening('.message.updated');
      channel.stopListening('.message.deleted');
      echo.leave(`room.${roomId}`);
    };
  }, [echo, roomId, slug, me, queryClient]);

  // gap-fill whenever the store flags a hole (TC-CORE-004)
  useEffect(() => {
    if (state.needsFill !== null) {
      void fillGap(state.needsFill.afterSeq, state.needsFill.beforeSeq);
    }
  }, [state.needsFill, fillGap]);

  // clear unread on open
  useEffect(() => {
    if (!query.isLoading && state.messages.length > 0 && roomId !== undefined) {
      markRead(state.messages[state.messages.length - 1]!.seq);
    }
    // run on room open and initial seed only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isLoading, roomId, query.data]);

  // stick to bottom — unless a search jump target is pending
  useEffect(() => {
    if (aroundSeq !== undefined) {
      return;
    }
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, aroundSeq]);

  // FR-SRCH-001 — scroll the ?around_seq= hit into view once, then drop the param
  useEffect(() => {
    if (aroundSeq === undefined || query.isLoading || jumpedRef.current === `${roomId}:${aroundSeq}`) {
      return;
    }
    if (state.messages.some((m) => m.seq === aroundSeq)) {
      jumpedRef.current = `${roomId}:${aroundSeq}`;
      document.querySelector(`[data-seq="${aroundSeq}"]`)?.scrollIntoView({ block: 'center' });
      const next = new URLSearchParams(searchParams);
      next.delete('around_seq');
      setSearchParams(next, { replace: true });
    }
  }, [aroundSeq, query.isLoading, state.messages, roomId, searchParams, setSearchParams]);

  if (roomId === undefined || slug === undefined || me === null) {
    return null;
  }

  const room = roomQuery.data;
  const title = room?.room.type === 'dm' ? room.other_user?.display_name ?? 'Direct message' : room?.room.name ?? '…';
  const myMessages = state.messages.filter((m) => m.sender_id === me.id && m.deleted_at === null);
  const myNewestSeq = myMessages.length > 0 ? myMessages[myMessages.length - 1]!.seq : 0;
  const other = readStatusQuery.data?.read_by.find((entry) => entry.user_id !== me.id);
  const seen = other !== undefined && other.last_read_seq >= myNewestSeq && myNewestSeq > 0;

  let lastDay = '';

  // FR-MSG-005/006 — edit (sender only), delete (sender anytime, moderator for others)
  const canModerate = roomQuery.data?.my_role === 'owner' || roomQuery.data?.my_role === 'admin';
  const editMessage = async (messageId: string, body: string) => {
    await endpoints.editMessage(messageId, slug, body);
    void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
  };
  const deleteMessage = async (messageId: string) => {
    await endpoints.deleteMessage(messageId, slug);
    void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <h2 className="text-base font-semibold">{room?.room.type === 'dm' ? '· ' : '# '}{title}</h2>
          {room?.room.type === 'group' && room.room.member_count > 0 && (
            <p className="text-xs text-slate-400">{room.room.member_count} members</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {seen && <span className="text-xs font-medium text-slate-400" data-testid="seen-indicator">Seen</span>}
          <button
            onClick={() => setMediaOpen((v) => !v)}
            aria-pressed={mediaOpen}
            aria-label="Media and files"
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            data-testid="room-media-toggle"
          >
            🖼
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto px-4 py-3" data-testid="message-list">
        {!query.isLoading && query.data?.has_more_before === true && (
          <button
            onClick={() => void loadOlder()}
            className="mx-auto block rounded-full bg-white px-4 py-1 text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-50"
          >
            Load older messages
          </button>
        )}
        {query.isLoading && <p className="text-center text-sm text-slate-400">Loading messages…</p>}
        {state.fillTimedOut && (
          <p className="text-center text-xs text-amber-600">Some messages failed to load — refresh to resync.</p>
        )}
        {state.messages.map((message) => {
          const day = dayLabel(message.created_at);
          const divider = day !== lastDay;
          lastDay = day;
          return (
            <div key={message.id} data-seq={message.seq}>
              {divider && (
                <div className="my-3 text-center">
                  <span className="rounded-full bg-slate-200 px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{day}</span>
                </div>
              )}
              <MessageItem
                message={message}
                mine={message.sender_id === me.id}
                canModerate={canModerate}
                onEdit={editMessage}
                onDelete={deleteMessage}
              />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <Composer roomId={roomId} workspaceId={room?.room.workspace_id ?? currentWorkspace?.workspace.id ?? ''} slug={slug} senderId={me.id} members={membersQuery.data ?? []} />
      </div>
      {mediaOpen && <RoomMediaPanel roomId={roomId} slug={slug} onClose={() => setMediaOpen(false)} />}
    </div>
  );
}
