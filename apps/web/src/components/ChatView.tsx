import { createPortal } from 'react-dom';
import { useChatText } from '../lib/use-chat-text';
import { useChatScroll } from '../hooks/useChatScroll';
import {CallButtons} from './calls/CallProvider';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventEnvelope, Message, ReadStatusEntry } from '@banana-chat/shared';
import { ApiError } from '@banana-chat/api-client';
import { SECRET_EXPIRY_MIN_DAYS, SECRET_EXPIRY_MAX_DAYS, continuesMessage, RoomSync, ReadReceiptReporter, secretExpiryAbsolute, secretExpiryState, isSecretRoomActive, type OutboxEntry } from '@banana-chat/chat-core';
import { sessionOutbox } from '../lib/outbox';
import { endpoints } from '../lib/api';
import { evictRoom } from '../lib/room-eviction';
import { useMessageStore, roomStore } from '../lib/room-stores';
import { useMessagePage } from '../hooks/useMessages';
import { useEcho } from '../echo/EchoProvider';
import { useSession } from '../state/session';
import { MessageItem } from './MessageItem';
import { ReadReceiptTrigger, ReadReceiptDialog } from './ReadReceipt';
import { Avatar, Icon } from './Visual';
import { Composer } from './Composer';
import { useRoomTools } from '../hooks/useRoomTools';
import { NotesPanel } from './NotesPanel';
import { RoomMediaPanel } from './RoomMediaPanel';

export function ChatView() {
  const { text, locale } = useChatText();
  const { roomId } = useParams<{ roomId: string }>();
  const { me, currentWorkspace } = useSession();
  const { echo, connected } = useEcho();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const slug = currentWorkspace?.workspace.slug;
  const [searchParams, setSearchParams] = useSearchParams();
  // search jump-to-result (FR-SRCH-001): seed the page around the hit
  const aroundSeqParam = searchParams.get('around_seq');
  const parsedSeq = Number(aroundSeqParam);
  const aroundSeq = aroundSeqParam !== null && Number.isSafeInteger(parsedSeq) && parsedSeq > 0 ? parsedSeq : undefined;
  const { query, loadOlder, fillGap, loadingOlder, olderError, olderRemaining } = useMessagePage(roomId, slug, Number.isFinite(aroundSeq) ? aroundSeq : undefined);
  const state = useMessageStore(roomId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const jumpedRef = useRef<string | undefined>(undefined);
  const [reply, setReply] = useState<Message | null>(null);
  // FR-READ-002 — owned by the room, not by whichever message triggered it:
  // sending a new own message changes lastMineMessage and unmounts that
  // message's ReadReceiptTrigger, which must not also close this dialog.
  const [readListFor, setReadListFor] = useState<ReadStatusEntry[] | null>(null);
  const [secretChatFor, setSecretChatFor] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [toolError, setToolError] = useState('');
  const typingNames = useRoomTools(roomId, slug, me?.id);
  const pinsQuery = useQuery({queryKey:['pins', slug, roomId, me?.id], queryFn:() => endpoints.pins(roomId!, slug!), enabled:!!roomId && !!slug, refetchInterval:15000});
  const [mediaOpen, setMediaOpen] = useState(false);
  useEffect(() => {setSecretChatFor(null);setReply(null);setNotesOpen(false);setMediaOpen(false);setToolError('');setReadListFor(null);}, [roomId]);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const receipts = useRef<ReadReceiptReporter | null>(null);
  const [pending, setPending] = useState<OutboxEntry[]>([]);
  const scroll = useChatScroll({ scope: `${me?.id}:${currentWorkspace?.workspace.id}:${roomId}`, listRef, contentRef,
    messages: state.messages, pendingCount: pending.length, userId: me?.id, anchorMode: aroundSeq !== undefined });
  const onIncoming = scroll.onIncoming;
  const lastMineMessage = [...state.messages].reverse().find(message => message.sender_id === me?.id && message.deleted_at === null);
  const myNewestSeq = lastMineMessage?.seq ?? 0;
  const [returnPosition, setReturnPosition] = useState<{seq: number; offset: number} | null>(null);
  const returnJump = useRef<{seq: number; offset: number} | null>(null);
  const jumpTo = (seq: number) => {
    const list = listRef.current;
    const top = list?.getBoundingClientRect().top ?? 0;
    const row = [...(list?.querySelectorAll<HTMLElement>('[data-seq]') ?? [])].find(el => el.getBoundingClientRect().bottom > top);
    setReturnPosition(row ? {seq: Number(row.dataset.seq), offset: row.getBoundingClientRect().top - top} : null);
    jumpedRef.current = undefined;
    setSearchParams({ around_seq: String(seq) });
  };
  const latest = () => { setReturnPosition(null); setSearchParams({}); scroll.toLatest(); };
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

  // FR-READ-002 — dm shows "Seen"; group shows "Read by N" + who (both read
  // the same room-agnostic endpoint, which already returns every member
  // whose last_read_seq >= seq, self included).
  const readStatusQuery = useQuery({
    queryKey: ['read-status', roomId, me?.id, currentWorkspace?.workspace.id, myNewestSeq],
    queryFn: () => endpoints.readStatus(roomId!, slug!, myNewestSeq),
    enabled: roomId !== undefined && slug !== undefined && myNewestSeq > 0
      && (roomQuery.data?.room.type === 'dm' || roomQuery.data?.room.type === 'group'),
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
      if (!store.getState().messages.some(existing => existing.id === message.id)) onIncoming(message);
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

    // EVT-003 room.deleted on the room channel — owner deletion or secret
    // expiry (FR-ROOM-012): leave immediately, purging every local layer
    // (cache, store, outbox, query content) via the envelope's workspace.
    const onRoomDeleted = (envelope: EventEnvelope<{ room_id: string }>) => {
      const workspaceId = envelope.workspace_id || currentWorkspace!.workspace.id;
      void evictRoom({ userId: me.id, workspaceId }, roomId);
      navigate('/');
    };
    channel.listen('.room.deleted', onRoomDeleted);

    return () => {
      channel.stopListening('.message.created');
      channel.stopListening('.room.read');
      channel.stopListening('.message.updated');
      channel.stopListening('.message.deleted');
      channel.stopListening('.room.deleted');
      echo.leave(`room.${roomId}`);
    };
  }, [echo, roomId, slug, me, queryClient, currentWorkspace, navigate, onIncoming]);

  // gap-fill whenever the store flags a hole (TC-CORE-004)
  useEffect(() => {
    if (state.needsFill !== null) {
      void fillGap(state.needsFill.afterSeq, state.needsFill.beforeSeq).catch(() => undefined);
    }
  }, [state.needsFill, fillGap]);

  useEffect(() => {
    setReturnPosition(null);
    jumpedRef.current = undefined;
    visible.current = false;
  }, [roomId, slug]);

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
  const [highlightSeq, setHighlightSeq] = useState<number | undefined>(undefined);
  useEffect(() => { setHighlightSeq(undefined); }, [roomId, aroundSeq]);
  useEffect(() => {
    if (aroundSeq === undefined || query.isLoading || jumpedRef.current === `${roomId}:${aroundSeq}`) {
      return;
    }
    if (state.messages.some((m) => m.seq === aroundSeq)) {
      jumpedRef.current = `${roomId}:${aroundSeq}`;
      listRef.current?.querySelector(`[data-seq="${aroundSeq}"]`)?.scrollIntoView({ block: 'center' });
      if (returnJump.current?.seq === aroundSeq && listRef.current) {
        const row = listRef.current.querySelector<HTMLElement>(`[data-seq="${aroundSeq}"]`);
        if (row) listRef.current.scrollTop += row.getBoundingClientRect().top - listRef.current.getBoundingClientRect().top - returnJump.current.offset;
        returnJump.current = null;
      }
      scroll.capture();
      // FR-UI-MB-005 — reply-quote jump (routed through the same around_seq
      // mechanism as search) highlights its destination for 1.5s so landing
      // somewhere in history isn't ambiguous.
      setHighlightSeq(aroundSeq);

    }
  }, [aroundSeq, query.isLoading, state.messages, roomId]);
  useEffect(() => {
    if (highlightSeq === undefined) return;
    const timer = setTimeout(() => setHighlightSeq(undefined), 1500);
    return () => clearTimeout(timer);
  }, [highlightSeq]);

  // FR-ROOM-012 — a secret room past its deadline: the server already purged
  // it; evict local traces and explain instead of a generic error. (Kept
  // above the early returns so hook order stays stable.)
  //
  // Offline path: while offline/asleep no 410 or EVT arrives, so the cached
  // room-list metadata decides — re-checked on visibility/pageshow so a
  // laptop that slept past the deadline never shows cached secret messages.
  const [offlineExpired, setOfflineExpired] = useState(false);
  useEffect(() => {
    if (roomId === undefined || slug === undefined) {
      return;
    }
    const check = () => {
      const rooms = queryClient.getQueryData<{ room: { id: string; is_secret?: boolean; secret_expires_at?: string | null } }[]>(['rooms', slug, 'all']) ?? [];
      const meta = rooms.find((item) => item.room.id === roomId)?.room;
      setOfflineExpired(meta !== undefined && secretExpiryState(meta).kind === 'expired');
    };
    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
    };
  }, [roomId, slug, queryClient, connected]);

  const roomExpired = offlineExpired
    || [query.error, roomQuery.error].some(
      (e) => e instanceof ApiError && (e.code === 'ROOM_EXPIRED' || e.status === 410),
    );
  useEffect(() => {
    if (roomExpired && roomId !== undefined && slug !== undefined && me !== null && currentWorkspace !== null) {
      void evictRoom({ userId: me.id, workspaceId: currentWorkspace.workspace.id }, roomId);
    }
  }, [roomExpired, roomId, slug, me, currentWorkspace, queryClient]);

  if (roomId === undefined || slug === undefined || me === null) {
    return null;
  }

  if (roomExpired) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-testid="secret-room-expired">
        <p className="text-4xl" aria-hidden="true">🔒</p>
        <h2 className="text-lg font-semibold">This secret room has expired</h2>
        <p className="max-w-sm text-sm text-slate-500">
          Messages, files, notes and calls were deleted from the server at expiry. Secret rooms are expiring rooms —
          not end-to-end encryption — and content may persist in normal server backups until those rotate.
        </p>
        <button onClick={() => navigate('/')} className="rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold">
          Back to conversations
        </button>
      </div>
    );
  }

  if (query.isError || roomQuery.isError) return <p role="alert" className="p-4">Unable to open this room. Check your connection and room access.</p>;
  const room = roomQuery.data;
  const secretActive = room !== undefined && isSecretRoomActive(room.room);
  const peerId = room?.other_user?.id ?? membersQuery.data?.find(member => member.id !== me.id)?.id;
  const title = room?.room.type === 'dm' ? room.other_user?.display_name ?? membersQuery.data?.find(member => member.id !== me.id)?.display_name ?? 'Direct message' : room?.room.name ?? '…';
  // Backend already filters read_by to last_read_seq >= myNewestSeq, so
  // everyone left after excluding me has read my latest message.
  const readers = readStatusQuery.data?.read_by.filter((entry) => entry.user_id !== me.id) ?? [];


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
      <div className="bc-conversation-pane flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="bc-chat-header">
        <button className="bc-chat-back bc-chat-control" aria-label={text('chat.back')} onClick={() => navigate('/')}><Icon name="back" /></button>
        <div className="bc-chat-identity">
          <Avatar name={title} />
          <div><h2>{title}</h2>
          {room?.room.type === 'group' && room.room.member_count > 0 && (
            <p className="text-xs text-slate-400">{room.room.member_count} members</p>
          )}
          {room?.room.type === 'dm' && <p className="bc-caption">Direct conversation</p>}
          {secretActive && room?.room.secret_expires_at != null && (
            <p className="text-xs font-medium text-amber-600" data-testid="secret-expiry-header" title="Secret room — messages and files are deleted at expiry; not end-to-end encrypted">
              🔒 Secret — deletes {secretExpiryAbsolute(room.room.secret_expires_at)}
            </p>
          )}
          </div>
        </div>
        <div className="bc-header-actions">
          <div className="bc-desktop-calls">{room && (room.room.type === 'dm' || room.room.type === 'group') && <CallButtons roomId={roomId} type={room.room.type} />}</div>
          <details className="bc-room-tools" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
            <summary aria-label={text('chat.tools')}><Icon name="more" /></summary>
            <div className="bc-room-tools-menu" onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.closest('details')?.removeAttribute('open'); }}>
              <div className="bc-mobile-calls">{room && (room.room.type === 'dm' || room.room.type === 'group') && <CallButtons roomId={roomId} type={room.room.type} />}</div>
              <button onClick={() => {setNotesOpen(!notesOpen);setMediaOpen(false);}} aria-label="Room notes"><Icon name="notes" size={18} />{text('chat.notes')}</button>
              <button onClick={() => {setMediaOpen(v => !v);setNotesOpen(false);}} aria-pressed={mediaOpen} aria-label="Media and files" data-testid="room-media-toggle"><Icon name="files" size={18} />{text('chat.files')}</button>
              {room?.room.type === 'dm' && !secretActive && (
                <button disabled={!peerId} onClick={() => setSecretChatFor(roomId)}>
                  <span aria-hidden="true">🔒</span>{text('chat.openSecretChat')}
                </button>
              )}
            </div>
          </details>
        </div>
      </header>
      {secretChatFor === roomId && room?.room.type === 'dm' && !secretActive && peerId && (
        <SecretChatDialog key={`${slug}:${roomId}`} peerId={peerId} slug={slug} onClose={() => setSecretChatFor(null)} />
      )}
      {room?.room.type === 'group' && <div className="bc-chat-ai-notice"><Icon name="sparkle" size={14} /><span>{text('chat.aiNotice')}</span><a href="/ai">{text('chat.aiDetails')}</a></div>}
      {!!pinsQuery.data?.length && <details className="bc-chat-pins"><summary><Icon name="pin" size={14} />{text('chat.pinned')}<span>{pinsQuery.data.length}</span></summary><div>{pinsQuery.data.map(pin => <div key={pin.id}><button onClick={() => jumpTo(pin.seq)}>{pin.body ?? pin.attachments[0]?.original_name ?? 'Message'}</button><button aria-label="Unpin message" onClick={async () => {try {await endpoints.pin(roomId, slug, pin.id, false);void pinsQuery.refetch();}catch(e){setToolError(e instanceof Error ? e.message : 'Unable to unpin');}}}><Icon name="close" size={16} /></button></div>)}</div></details>}
      {toolError && <p role="alert">{toolError}</p>}

      <div className="bc-timeline-frame">
      <div ref={listRef} onScroll={() => {
        scroll.onScroll();
        if (listRef.current && listRef.current.scrollTop < 160 && aroundSeq === undefined && !query.isLoading && !loadingOlder && !olderError && (olderRemaining ?? query.data?.has_more_before)) void loadOlder();
      }} className="bc-message-list" data-testid="message-list">
      <div ref={contentRef} className="bc-timeline-content">
        {aroundSeq !== undefined && <div className="bc-history-context"><button onClick={latest}>{text('chat.latest')}</button>{returnPosition !== null && <button onClick={() => { const seq = returnPosition!.seq; returnJump.current = returnPosition; setReturnPosition(null); jumpedRef.current = undefined; setSearchParams({around_seq:String(seq)}); }}>{text('chat.return')}</button>}{!query.isLoading && !state.messages.some(m => m.seq === aroundSeq) && <p role="status">{text('chat.jumpMissing')}</p>}</div>}
        {!query.isLoading && (olderRemaining ?? query.data?.has_more_before) === true && <div className="bc-history-loader">{olderError && <p role="alert">{text('chat.historyError')}</p>}<button data-testid="history-load-more" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? text('chat.loading') : olderError ? text('chat.retry') : text('chat.older')}</button></div>}
        {query.isLoading && <p className="bc-timeline-status">{text('chat.loading')}</p>}
        {!query.isLoading && state.messages.length === 0 && pending.length === 0 && <div className="bc-empty-conversation"><Icon name="chat" size={30} /><h3>{text('chat.emptyRoom')}</h3><p>{text('chat.emptyRoomHint')}</p></div>}
        {state.fillTimedOut && (
          <p className="text-center text-xs text-amber-600">Some messages failed to load — refresh to resync.</p>
        )}
        {state.messages.map((message, index) => {
          const date = new Date(message.created_at);
          const today = new Date();
          const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
          const day = date.toDateString() === today.toDateString() ? text('chat.today') : date.toDateString() === yesterday.toDateString() ? text('chat.yesterday') : date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
          const divider = index === 0 || new Date(state.messages[index - 1].created_at).toDateString() !== new Date(message.created_at).toDateString();
          return (
            <div key={message.id} data-seq={message.seq} data-highlight={message.seq === highlightSeq}>
              {divider && (
                <div className="bc-day-divider my-3 text-center">
                  <span className="rounded-full bg-slate-200 px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{day}</span>
                </div>
              )}
              <MessageItem
                message={message}
                grouped={!divider && continuesMessage(state.messages[index - 1], message)}
                mine={message.sender_id === me.id}
                showSender={room?.room.type !== 'dm'}
                replySender={membersQuery.data?.find(member => member.id === message.reply_to?.sender_id)?.display_name}
                canModerate={canModerate}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReply={setReply}
                onJump={jumpTo}
                onPin={async message => {try {await endpoints.pin(roomId, slug, message.id, true);void pinsQuery.refetch();}catch(e){setToolError(e instanceof Error ? e.message : 'Unable to pin');}}}
              />
              {/* FR-READ-002 — read receipt sits under our own latest message,
                  not detached in the header where it wasn't tied to what was
                  actually read. */}
              {room?.room.type !== undefined && message.id === lastMineMessage?.id && (
                <ReadReceiptTrigger roomType={room.room.type === 'dm' ? 'dm' : 'group'} others={readers} text={text} onOpen={setReadListFor} />
              )}
            </div>
          );
        })}
        {pending.filter(entry => !state.messages.some(message => message.client_message_id === entry.client_message_id)).map(entry => (
          <div key={entry.id} data-testid="outbox-message" className="bc-outbox-bubble">
            <p className="whitespace-pre-wrap">{entry.body}</p>
            {entry.attachments.map(a => <p key={a.attachment_id}>📎 {a.original_name}</p>)}
            <small>{entry.status === 'failed' ? entry.last_error ?? text('chat.failed') : entry.status === 'sending' ? text('chat.sending') : text('chat.pending')}</small>
            {entry.status === 'failed' && <button data-testid="outbox-retry" onClick={() => void sessionOutbox().outbox.retry(entry.id)}>{text('chat.retry')}</button>}
            {entry.status !== 'sending' && <button onClick={() => void sessionOutbox().outbox.remove(entry.id)}>{text('chat.remove')}</button>}
          </div>
        ))}
        <div ref={bottomRef} className="h-px" />
      </div>
      </div>
      {(scroll.away || aroundSeq !== undefined) && <button className="bc-jump-latest" data-testid="jump-to-latest" onClick={latest} aria-label={text('chat.latest')}><Icon name="down" size={18} />{scroll.newCount > 0 ? <span>{scroll.newCount} {text('chat.newMessages')}</span> : <span>{text('chat.latest')}</span>}</button>}
      </div>

      <div className="bc-typing" role="status" data-testid="typing-indicator">{typingNames.length > 0 && <><span className="bc-typing-dots">•••</span> {typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing…</>}</div>
      <Composer onQueued={latest} reply={reply} onReplyClear={() => setReply(null)} key={`${me.id}:${roomId}`} roomId={roomId} workspaceId={room?.room.workspace_id ?? currentWorkspace?.workspace.id ?? ''} slug={slug} senderId={me.id} members={[...(membersQuery.data ?? []), ...(room?.room.type === 'group' ? [{id:'ai-bot', username:'ai', display_name:'AI Assistant', avatar_attachment_id:null}] : [])]} />
      </div>
      {notesOpen && <NotesPanel key={roomId} roomId={roomId} slug={slug} me={me.id} canModerate={canModerate} onClose={() => setNotesOpen(false)} />}
      {mediaOpen && <RoomMediaPanel roomId={roomId} slug={slug} onClose={() => setMediaOpen(false)} />}
      {readListFor !== null && <ReadReceiptDialog entries={readListFor} onClose={() => setReadListFor(null)} text={text} />}
    </div>
  );
}

/** FR-ROOM-012: explicit expiry and disclosure before opening a separate secret DM. */
function SecretChatDialog({ peerId, slug, onClose }: { peerId: string; slug: string; onClose: () => void }) {
  const { text } = useChatText();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    mounted.current = true;
    dialogRef.current?.showModal();
    return () => { mounted.current = false; };
  }, []);
  const create = useMutation({
    mutationFn: () => endpoints.createDm(peerId, slug, { secret: true, expiryDays }),
    onSuccess: async detail => {
      await queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      if (!mounted.current) return;
      onClose();
      navigate(`/rooms/${detail.room.id}`);
    },
  });
  return createPortal(
    <dialog ref={dialogRef} className="bc-message-menu bc-read-list" aria-label={text('chat.openSecretChat')}
      onCancel={event => { if (create.isPending) event.preventDefault(); else onClose(); }}>
      <div className="bc-message-menu-heading"><strong>🔒 {text('chat.openSecretChat')}</strong></div>
      <form className="space-y-3 p-3" onSubmit={event => { event.preventDefault(); if (!create.isPending) create.mutate(); }}>
        <label className="flex items-center gap-2 text-sm">
          {text('room.secret.expiryDays')}
          <select autoFocus value={expiryDays} disabled={create.isPending} onChange={event => setExpiryDays(Number(event.target.value))}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm">
            {Array.from({ length: SECRET_EXPIRY_MAX_DAYS - SECRET_EXPIRY_MIN_DAYS + 1 }, (_, i) => SECRET_EXPIRY_MIN_DAYS + i).map(days => (
              <option key={days} value={days}>{text('room.secret.days').replace('{days}', String(days))}</option>
            ))}
          </select>
        </label>
        <p className="text-xs leading-relaxed text-slate-500">{text('room.secret.explain')}</p>
        {create.isError && <p role="alert" className="text-sm text-red-700">{create.error instanceof ApiError ? create.error.message : text('common.error')}</p>}
        <button type="submit" disabled={create.isPending}>{text(create.isPending ? 'common.loading' : 'chat.openSecretChat')}</button>
        <button type="button" disabled={create.isPending} onClick={onClose}>{text('common.cancel')}</button>
      </form>
    </dialog>, document.body,
  );
}
