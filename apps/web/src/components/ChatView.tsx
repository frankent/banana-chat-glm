import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventEnvelope, Message } from '@banana-chat/shared';
import { continuesMessage, RoomSync, ReadReceiptReporter, type OutboxEntry } from '@banana-chat/chat-core';
import { sessionOutbox } from '../lib/outbox';
import { endpoints } from '../lib/api';
import { useMessageStore, roomStore } from '../lib/room-stores';
import { useMessagePage } from '../hooks/useMessages';
import { useEcho } from '../echo/EchoProvider';
import { useSession } from '../state/session';
import { MessageItem } from './MessageItem';
import { Avatar, Icon } from './Visual';
import { Composer } from './Composer';
import { useRoomTools } from '../hooks/useRoomTools';
import { NotesPanel } from './NotesPanel';
import { RoomMediaPanel } from './RoomMediaPanel';

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ChatView() {
  const { roomId } = useParams<{ roomId: string }>();
  const { me, currentWorkspace } = useSession();
  const { echo, connected } = useEcho();
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
  const [reply, setReply] = useState<Message | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [toolError, setToolError] = useState('');
  const typingNames = useRoomTools(roomId, slug, me?.id);
  const pinsQuery = useQuery({queryKey:['pins', slug, roomId, me?.id], queryFn:() => endpoints.pins(roomId!, slug!), enabled:!!roomId && !!slug, refetchInterval:15000});
  useEffect(() => {setReply(null);setNotesOpen(false);setToolError('');}, [roomId]);
  const [mediaOpen, setMediaOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const scrollHeight = useRef(0);
  const scrollTop = useRef(0);
  const previousHead = useRef<number | undefined>(undefined);
  const visible = useRef(false);
  const receipts = useRef<ReadReceiptReporter | null>(null);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const [olderRemaining, setOlderRemaining] = useState<boolean | null>(null);
  useEffect(() => {
    if (!me || !currentWorkspace || !roomId) return;
    const { outbox, ready } = sessionOutbox();
    const update = () => setPending(outbox.entriesForRoom(roomId));
    const unsubscribe = outbox.subscribe(update);
    void ready.then(update);
    update();
    return unsubscribe;
  }, [me?.id, currentWorkspace?.workspace.id, roomId]);
  useEffect(() => {
    if (!roomId || !slug) return;
    let active = true;
    const store = roomStore(roomId);
    const sync = new RoomSync(store, options => endpoints.messages(roomId, slug, options), () => active);
    // Reconnect is transport state, not a guarantee that old events will replay.
    if (connected && aroundSeq === undefined) void sync.refresh().catch(() => undefined);
    return () => { active = false; };
  }, [connected, roomId, slug, aroundSeq]);

  const roomQuery = useQuery({
    queryKey: ['room', roomId, me?.id, currentWorkspace?.workspace.id],
    queryFn: () => endpoints.room(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined,
    staleTime: 60_000,
  });

  // roster for @mention autocomplete (FR-MSG-008)
  const membersQuery = useQuery({
    queryKey: ['room-members', roomId, me?.id, currentWorkspace?.workspace.id],
    queryFn: () => endpoints.roomMembers(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined,
    staleTime: 60_000,
  });

  const readStatusQuery = useQuery({
    queryKey: ['read-status', roomId, me?.id, currentWorkspace?.workspace.id],
    queryFn: () => endpoints.readStatus(roomId!, slug!),
    enabled: roomId !== undefined && slug !== undefined && roomQuery.data?.room.type === 'dm',
  });

  const markRead = (seq: number) => {
    if (roomId === undefined || slug === undefined || seq <= 0) {
      return;
    }
    return endpoints.markRead(roomId, slug, seq).then(() => {
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
      if (message.sender_id === me.id) {
        void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      }
    };

    const onRead = () => {
      void queryClient.invalidateQueries({ queryKey: ['read-status', roomId, me?.id, currentWorkspace?.workspace.id] });
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
      void fillGap(state.needsFill.afterSeq, state.needsFill.beforeSeq).catch(() => undefined);
    }
  }, [state.needsFill, fillGap]);

  useEffect(() => {
    atBottom.current = true;
    previousHead.current = undefined;
    scrollHeight.current = 0;
    scrollTop.current = 0;
    setOlderRemaining(null);
  }, [roomId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const head = state.messages[0]?.seq;
    const prepended = head !== undefined && previousHead.current !== undefined && head < previousHead.current;
    if (prepended) list.scrollTop = scrollTop.current + list.scrollHeight - scrollHeight.current;
    else if (aroundSeq === undefined && atBottom.current) list.scrollTop = list.scrollHeight;
    previousHead.current = head;
    scrollHeight.current = list.scrollHeight;
    scrollTop.current = list.scrollTop;
  }, [state.messages.length, pending.length, aroundSeq]);

  useEffect(() => {
    const list = listRef.current;
    const bottom = bottomRef.current;
    if (!list || !bottom || !roomId || !slug) return;
    const reporter = new ReadReceiptReporter(async seq => { await markRead(seq); },
      () => visible.current && document.visibilityState === 'visible' && document.hasFocus() && aroundSeq === undefined);
    receipts.current = reporter;
    const observe = () => reporter.observe(roomStore(roomId).newestSeq);
    const observer = new IntersectionObserver(entries => { visible.current = entries[0]?.isIntersecting ?? false; observe(); }, { root: list });
    observer.observe(bottom);
    document.addEventListener('visibilitychange', observe);
    window.addEventListener('focus', observe);
    return () => { reporter.dispose(); observer.disconnect(); document.removeEventListener('visibilitychange', observe); window.removeEventListener('focus', observe); };
  }, [roomId, slug, aroundSeq, query.isLoading]);
  useEffect(() => { receipts.current?.observe(state.messages.at(-1)?.seq ?? 0); }, [state.messages]);

  // FR-SRCH-001 — preserve the search anchor until the member returns to latest
  useEffect(() => {
    if (aroundSeq === undefined || query.isLoading || jumpedRef.current === `${roomId}:${aroundSeq}`) {
      return;
    }
    if (state.messages.some((m) => m.seq === aroundSeq)) {
      jumpedRef.current = `${roomId}:${aroundSeq}`;
      document.querySelector(`[data-seq="${aroundSeq}"]`)?.scrollIntoView({ block: 'center' });

    }
  }, [aroundSeq, query.isLoading, state.messages, roomId, searchParams, setSearchParams]);

  if (roomId === undefined || slug === undefined || me === null) {
    return null;
  }

  if (query.isError || roomQuery.isError) return <p role="alert" className="p-4">Unable to open this room. Check your connection and room access.</p>;
  const room = roomQuery.data;
  const title = room?.room.type === 'dm' ? room.other_user?.display_name ?? membersQuery.data?.find(member => member.id !== me.id)?.display_name ?? 'Direct message' : room?.room.name ?? '…';
  const myMessages = state.messages.filter((m) => m.sender_id === me.id && m.deleted_at === null);
  const myNewestSeq = myMessages.length > 0 ? myMessages[myMessages.length - 1]!.seq : 0;
  const other = readStatusQuery.data?.read_by.find((entry) => entry.user_id !== me.id);
  const seen = other !== undefined && other.last_read_seq >= myNewestSeq && myNewestSeq > 0;

  let lastDay = '';

  // FR-MSG-005/006 — edit (sender only), delete (sender anytime, moderator for others)
  const canModerate = roomQuery.data?.my_role === 'owner' || roomQuery.data?.my_role === 'admin' || currentWorkspace?.role === 'owner' || currentWorkspace?.role === 'admin';
  const editMessage = async (messageId: string, body: string) => {
    const response = await endpoints.editMessage(messageId, slug, body);
    roomStore(roomId).add(response.message);
    void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
  };
  const deleteMessage = async (messageId: string) => {
    await endpoints.deleteMessage(messageId, slug);
    roomStore(roomId).markDeleted(messageId, new Date().toISOString(), 'sender');
    void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
  };

  return (
    <div className="bc-chat flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="bc-chat-header">
        <div className="bc-chat-identity">
          {room?.room.type === 'dm' ? <Avatar name={title} /> : <span className="bc-room-hash" aria-hidden="true">#</span>}
          <div><h2>{title}</h2>
          {room?.room.type === 'group' && room.room.member_count > 0 && (
            <p className="text-xs text-slate-400">{room.room.member_count} members</p>
          )}
          {room?.room.type === 'dm' && <p className="bc-caption">Direct conversation</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="bc-tool-button" onClick={() => {setNotesOpen(!notesOpen);setMediaOpen(false);}} aria-label="Room notes">Notes</button>
          {seen && <span className="text-xs font-medium text-slate-400" data-testid="seen-indicator">Seen</span>}
          <button
            onClick={() => {setMediaOpen((v) => !v);setNotesOpen(false);}}
            aria-pressed={mediaOpen}
            aria-label="Media and files"
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            data-testid="room-media-toggle"
          >
            <Icon name="files" />
          </button>
        </div>
      </header>
      {room?.room.type === 'group' && <div className="bc-bot-presence"><Icon name="sparkle" size={13} /> AI bot is here · mention <strong>@ai</strong> to ask. Only your mention is sent to AI. <a href="/ai">AI setup & consent</a></div>}
      {!!pinsQuery.data?.length && <div className="bc-pins" aria-label="Pinned messages">{pinsQuery.data.map(pin => <div key={pin.id}><button onClick={() => setSearchParams({around_seq:String(pin.seq)})}>⌖ <span>{pin.body ?? pin.attachments[0]?.original_name ?? 'Message'}</span></button><button aria-label="Unpin message" onClick={async () => {try {await endpoints.pin(roomId, slug, pin.id, false);void pinsQuery.refetch();}catch(e){setToolError(e instanceof Error ? e.message : 'Unable to unpin');}}}>✕</button></div>)}</div>}
      {toolError && <p role="alert">{toolError}</p>}

      <div ref={listRef} onScroll={() => {
        const list = listRef.current!;
        atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        scrollHeight.current = list.scrollHeight;
        scrollTop.current = list.scrollTop;
      }} className="bc-message-list flex-1 space-y-1 overflow-y-auto" data-testid="message-list">
        {aroundSeq !== undefined && <button onClick={() => { atBottom.current = true; setSearchParams({}); }}>Back to latest messages</button>}
        {!query.isLoading && (olderRemaining ?? query.data?.has_more_before) === true && (
          <button
            onClick={() => void loadOlder().then(setOlderRemaining)}
            className="mx-auto block rounded-full bg-white px-4 py-1 text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-50"
          >
            Load older messages
          </button>
        )}
        {query.isLoading && <p className="text-center text-sm text-slate-400">Loading messages…</p>}
        {state.fillTimedOut && (
          <p className="text-center text-xs text-amber-600">Some messages failed to load — refresh to resync.</p>
        )}
        {state.messages.map((message, index) => {
          const day = dayLabel(message.created_at);
          const divider = day !== lastDay;
          lastDay = day;
          return (
            <div key={message.id} data-seq={message.seq}>
              {divider && (
                <div className="bc-day-divider my-3 text-center">
                  <span className="rounded-full bg-slate-200 px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{day}</span>
                </div>
              )}
              <MessageItem
                message={message}
                grouped={!divider && continuesMessage(state.messages[index - 1], message)}
                mine={message.sender_id === me.id}
                canModerate={canModerate}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReply={setReply}
                onJump={seq => setSearchParams({around_seq:String(seq)})}
                onPin={async message => {try {await endpoints.pin(roomId, slug, message.id, true);void pinsQuery.refetch();}catch(e){setToolError(e instanceof Error ? e.message : 'Unable to pin');}}}
              />
            </div>
          );
        })}
        {pending.filter(entry => !state.messages.some(message => message.client_message_id === entry.client_message_id)).map(entry => (
          <div key={entry.id} data-testid="outbox-message" className="ml-auto max-w-[70%] rounded-xl bg-yellow-100 p-3 text-sm">
            <p className="whitespace-pre-wrap">{entry.body}</p>
            {entry.attachments.map(a => <p key={a.attachment_id}>📎 {a.original_name}</p>)}
            <small>{entry.status === 'failed' ? entry.last_error : entry.status === 'sending' ? 'sending…' : 'Pending — waiting to send'}</small>
            {entry.status === 'failed' && <button data-testid="outbox-retry" onClick={() => void sessionOutbox().outbox.retry(entry.id)}>Retry</button>}
            {entry.status !== 'sending' && <button onClick={() => void sessionOutbox().outbox.remove(entry.id)}>Remove</button>}
          </div>
        ))}
        <div ref={bottomRef} className="h-px" />
      </div>

      <div className="bc-typing" role="status" data-testid="typing-indicator">{typingNames.length > 0 && <><span className="bc-typing-dots">•••</span> {typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing…</>}</div>
      <Composer reply={reply} onReplyClear={() => setReply(null)} key={`${me.id}:${roomId}`} roomId={roomId} workspaceId={room?.room.workspace_id ?? currentWorkspace?.workspace.id ?? ''} slug={slug} senderId={me.id} members={[...(membersQuery.data ?? []), ...(room?.room.type === 'group' ? [{id:'ai-bot', username:'ai', display_name:'AI Assistant', avatar_attachment_id:null}] : [])]} />
      </div>
      {notesOpen && <NotesPanel key={roomId} roomId={roomId} slug={slug} me={me.id} canModerate={canModerate} onClose={() => setNotesOpen(false)} />}
      {mediaOpen && <RoomMediaPanel roomId={roomId} slug={slug} onClose={() => setMediaOpen(false)} />}
    </div>
  );
}
