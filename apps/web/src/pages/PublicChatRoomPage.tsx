/**
 * FR-PCHAT-006/009/010 · API-221..228 — the agent-side conversation.
 *
 * A DEDICATED SLIM VIEW. `ChatView` is deliberately NOT reused: it renders
 * <CallButtons/> unconditionally, it takes `endpoints.*(roomId, slug)` on the
 * `rooms` surface, and it pulls roomStore / sessionOutbox / ReadReceiptReporter —
 * all of which are `rooms`-shaped. `Composer` is not reused either: its draft
 * key and its uploader are workspace-scoped.
 *
 * NO CALL AND NO MEETING BUTTON EXISTS IN THIS TREE. That is not a hidden
 * control: `CallService::allowed()` joins `rooms`, so a public chat room id does
 * not resolve there at all, and nothing on this page can mount a call.
 *
 * REPLYING AUTO-CLAIMS (FR-PCHAT-009) — server-side, inside the same
 * lockForUpdate transaction that assigns `seq`, so "exactly one claim" is a
 * database guarantee and the client neither asks for it nor races it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PUBLIC_CHAT_STATUSES, publicChatClaimState, publicChatStatusLabelKey } from '@banana-chat/chat-core';
import { t } from '@banana-chat/shared';
import type { PublicChatStatus, UserStub } from '@banana-chat/shared';
import { ApiError } from '@banana-chat/api-client';
import { endpoints } from '../lib/api';
import { interpolate, mergeBySeq, pchat, pchatErrorMessage, pchatTime } from '../lib/public-chat';
import type { PcStaffMessage, PcStaffRoom } from '../lib/public-chat';
import { useEcho } from '../echo/EchoProvider';
import { useSession } from '../state/session';
import { useUploader } from '../hooks/useUploader';
import type { UploadDriver } from '../hooks/useUploader';
import { Avatar, Icon } from '../components/Visual';
import { PcAttachments, PcReplyQuote, PcStatusPill } from '../components/PublicChatParts';
import './public-chat.css';

const en = (key: string) => t(key, 'en');
const PAGE = 50;

export function PublicChatRoomPage() {
  const { roomId = '' } = useParams();
  return <AgentRoom key={roomId} roomId={roomId} />;
}

function AgentRoom({ roomId }: { roomId: string }) {
  const { currentWorkspace, me } = useSession();
  const slug = currentWorkspace?.workspace.slug ?? '';
  const queryClient = useQueryClient();
  const { echo } = useEcho();

  const [messages, setMessages] = useState<PcStaffMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<PcStaffMessage | null>(null);
  const [error, setError] = useState('');
  const [visitorTyping, setVisitorTyping] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  // one idempotency key per composed message, REUSED across retries — the whole
  // point of client_message_id is that a retry replays instead of duplicating
  const clientMessageId = useRef(crypto.randomUUID());

  const room = useQuery({
    queryKey: ['public-chat', 'room', slug, roomId],
    queryFn: () => pchat.room(slug, roomId),
    enabled: slug !== '' && roomId !== '',
  });

  const members = useQuery({
    queryKey: ['public-chat', 'members', slug],
    queryFn: () => endpoints.directory('', slug),
    enabled: slug !== '',
    staleTime: 60_000,
  });

  const history = useQuery({
    queryKey: ['public-chat', 'messages', slug, roomId],
    queryFn: () => pchat.messages(slug, roomId, { limit: PAGE }),
    enabled: slug !== '' && roomId !== '',
  });

  useEffect(() => {
    if (history.data === undefined) return;
    setMessages((current) => mergeBySeq(current, history.data.messages));
    setHasEarlier(history.data.messages.length >= PAGE);
  }, [history.data]);

  // ---- realtime: the STAFF channel carries the internal payload -------------
  // The visitor channel (private-public-chat.{id}) exists too and agents may
  // mirror it, but this page reads the staff variant so it can show the
  // assignee, the raw status and the deleter — none of which the customer's
  // channel carries by construction (DEC-065).
  useEffect(() => {
    if (echo === null || roomId === '') return;
    const channel = echo.private(`public-chat-staff.${roomId}`);

    channel.listen('.public_chat.message.created', (envelope: { data?: { message?: PcStaffMessage } }) => {
      const message = envelope.data?.message;
      if (message === undefined) return;
      setMessages((current) => mergeBySeq(current, [message]));
    });
    channel.listen('.public_chat.message.deleted', (envelope: { data?: { message_id?: string } }) => {
      const id = envelope.data?.message_id;
      if (id === undefined) return;
      setMessages((current) =>
        current.map((message) => (message.id === id ? { ...message, deleted: true, body: null, attachments: [] } : message)),
      );
    });
    channel.listen('.public_chat.room.changed', (envelope: { data?: { room?: PcStaffRoom } }) => {
      const next = envelope.data?.room;
      if (next === undefined) return;
      queryClient.setQueryData(['public-chat', 'room', slug, roomId], { room: next });
    });

    let clear: ReturnType<typeof setTimeout> | null = null;
    channel.listen('.public_chat.typing', (envelope: { data?: { sender_kind?: string } }) => {
      if (envelope.data?.sender_kind !== 'visitor') return;
      setVisitorTyping(true);
      if (clear !== null) clearTimeout(clear);
      clear = setTimeout(() => setVisitorTyping(false), 4000);
    });

    return () => {
      if (clear !== null) clearTimeout(clear);
      channel.stopListening('.public_chat.message.created');
      channel.stopListening('.public_chat.message.deleted');
      channel.stopListening('.public_chat.room.changed');
      channel.stopListening('.public_chat.typing');
      echo.leave(`public-chat-staff.${roomId}`);
    };
  }, [echo, roomId, slug, queryClient]);

  // ---- FR-PCHAT-010 per-agent read pointer ---------------------------------
  // The response reports the pointer ACTUALLY in force after the monotonic
  // upsert, so a stale seq learns the truth instead of believing it moved. A
  // read pointer never affects queue order.
  const lastSeq = messages.length === 0 ? 0 : messages[messages.length - 1].seq;
  const reported = useRef(0);
  useEffect(() => {
    if (slug === '' || roomId === '' || lastSeq === 0 || lastSeq <= reported.current) return;
    reported.current = lastSeq;
    void pchat
      .markRead(slug, roomId, lastSeq)
      .then((state) => {
        queryClient.setQueryData<{ room: PcStaffRoom }>(['public-chat', 'room', slug, roomId], (current) =>
          current === undefined
            ? current
            : { room: { ...current.room, my_last_read_seq: state.last_read_seq, unread_count: state.unread_count } },
        );
        void queryClient.invalidateQueries({ queryKey: ['public-chat', 'summary', slug] });
      })
      .catch(() => {
        reported.current = 0; // let the next message retry it
      });
  }, [slug, roomId, lastSeq, queryClient]);

  // keyed on the NEWEST seq, not the length: "Load earlier" prepends, and a
  // length-keyed effect would scroll the agent straight back to the bottom the
  // moment they asked for history
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastSeq]);

  // ---- uploads: API-225 mints the ticket, the ordinary complete finishes it --
  // The agent IS the uploader here (uploader_id = the agent AND
  // public_chat_room_id = the room), so /uploads/{id}/complete authorises
  // normally — unlike the visitor tier, which has no user at all.
  const driver: UploadDriver = useMemo(
    () => ({
      create: (input) => pchat.createUpload(slug, roomId, input),
      complete: (attachmentId, parts) => endpoints.completeUpload(attachmentId, slug, parts),
      poll: (attachmentId) => endpoints.attachment(attachmentId, slug),
    }),
    [slug, roomId],
  );
  const uploader = useUploader(slug, driver);

  /** Resolve a member ULID from a claimed/reassigned system row to a name. */
  const nameOf = useCallback(
    (userId: string | undefined): string =>
      userId === undefined ? '—' : ((members.data ?? []).find((member: UserStub) => member.id === userId)?.display_name ?? userId),
    [members.data],
  );

  const typingSent = useRef(0);
  const pingTyping = useCallback(() => {
    const now = Date.now();
    if (now - typingSent.current < 3000) return;
    typingSent.current = now;
    void pchat.agentTyping(slug, roomId, true).catch(() => {});
  }, [slug, roomId]);

  const send = useMutation({
    mutationFn: async () => {
      const attachmentIds = uploader.staged.filter((s) => s.attachmentId !== null && s.status !== 'error').map((s) => s.attachmentId as string);
      return pchat.send(slug, roomId, {
        client_message_id: clientMessageId.current,
        body: body.trim() === '' ? undefined : body.trim(),
        reply_to_message_id: replyTo?.id,
        attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
      });
    },
    // Retry transport and 5xx only. A 403/409/422 will not change on a second
    // attempt, and retrying a 429 spends the agent's remaining budget. The
    // reused client_message_id is what makes the 5xx retry safe.
    retry: (attempt, err) => attempt < 1 && !(err instanceof ApiError && err.status < 500),
    onSuccess: (result) => {
      setMessages((current) => mergeBySeq(current, [result.message]));
      setBody('');
      setReplyTo(null);
      uploader.clear();
      setError('');
      clientMessageId.current = crypto.randomUUID();
      // the first reply auto-claims: the room row and the queue both moved
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'room', slug, roomId] });
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'rooms', slug] });
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'summary', slug] });
    },
    onError: (err) => setError(pchatErrorMessage(err)),
  });

  const patch = useMutation({
    mutationFn: (input: { status?: PublicChatStatus; assigned_to?: string | null }) => pchat.updateRoom(slug, roomId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(['public-chat', 'room', slug, roomId], result);
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'rooms', slug] });
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'summary', slug] });
      setError('');
    },
    onError: (err) => setError(pchatErrorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (messageId: string) => pchat.deleteMessage(slug, messageId),
    // the tombstone is applied locally as well as on EVT-083: API-226 answers
    // 204, and waiting for the round trip through the socket would leave the
    // deleter looking at the message they just removed
    onSuccess: (_result, messageId) => {
      setMessages((current) =>
        current.map((message) => (message.id === messageId ? { ...message, deleted: true, body: null, attachments: [] } : message)),
      );
    },
    onError: (err) => setError(pchatErrorMessage(err)),
  });

  async function loadEarlier() {
    const oldest = messages[0]?.seq;
    if (oldest === undefined) return;
    const page = await pchat.messages(slug, roomId, { before_seq: oldest, limit: PAGE });
    setMessages((current) => mergeBySeq(current, page.messages));
    setHasEarlier(page.messages.length >= PAGE);
  }

  if (room.isError) {
    return (
      <div className="bc-pchat-room">
        <p role="alert" className="bc-pchat-alert">
          {room.error instanceof ApiError && room.error.status === 404
            ? en('pchat.error.PCHAT_ROOM_NOT_FOUND')
            : 'Could not load this conversation.'}{' '}
          <Link to="/public-chat">Back to the queue</Link>
        </p>
      </div>
    );
  }
  if (room.data === undefined) {
    return <div className="bc-pchat-room"><p className="bc-caption">Loading conversation…</p></div>;
  }

  const current = room.data.room;
  const claim = publicChatClaimState(current, me?.id ?? null);
  const canSend = current.status !== 'done';
  const busy = send.isPending || uploader.staged.some((s) => s.status === 'creating' || s.status === 'uploading');

  return (
    <div className="bc-pchat-room">
      <header className="bc-pchat-room-head">
        <Link className="bc-pchat-back" to="/public-chat" aria-label="Back to the support queue">
          <Icon name="arrow" size={16} />
        </Link>
        <div className="bc-pchat-room-who">
          {/* partner-supplied strings: text nodes, never Markdown (MANDATORY fix 20) */}
          <h2>{current.customer_name}</h2>
          <p>
            {current.provider_name}
            {current.external_ref !== null && <> · #{current.external_ref}</>}
            {' · '}
            {current.claimed_at === null
              ? en('pchat.room.unclaimed')
              : interpolate(en('pchat.room.claimedBy'), {
                  name: current.assigned_to?.display_name ?? '—',
                  time: pchatTime(current.claimed_at),
                })}
          </p>
        </div>
        <div className="bc-pchat-room-controls">
          <PcStatusPill status={current.status} />
          <label>
            <span className="bc-eyebrow">{en('pchat.room.status')}</span>
            <select
              aria-label={en('pchat.room.status')}
              value={current.status}
              disabled={patch.isPending}
              onChange={(event) => patch.mutate({ status: event.target.value as PublicChatStatus })}
            >
              {PUBLIC_CHAT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {en(publicChatStatusLabelKey(value))}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="bc-eyebrow">{en('pchat.room.assignee')}</span>
            <select
              aria-label={en('pchat.room.assignee')}
              value={current.assigned_to?.id ?? ''}
              disabled={patch.isPending}
              // API-224: the PRESENCE of the key requests the change, and
              // `assigned_to: null` is an explicit unassign.
              onChange={(event) => patch.mutate({ assigned_to: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">{en('pchat.filter.assignee.none')}</option>
              {(members.data ?? []).map((member: UserStub) => (
                <option key={member.id} value={member.id}>
                  {member.display_name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {claim === 'other' && (
        <p className="bc-pchat-notice" role="status">
          {interpolate(en('pchat.room.claimedBy'), {
            name: current.assigned_to?.display_name ?? '—',
            time: pchatTime(current.claimed_at),
          })}
        </p>
      )}
      {error !== '' && (
        <p className="bc-pchat-alert" role="alert">
          {error}
        </p>
      )}

      <div className="bc-pchat-transcript">
        {hasEarlier && (
          <button className="bc-pchat-more" onClick={() => void loadEarlier()}>
            Load earlier messages
          </button>
        )}
        {messages.map((message) => (
          <StaffMessageRow
            key={message.id}
            message={message}
            meId={me?.id ?? null}
            nameOf={nameOf}
            onReply={() => setReplyTo(message)}
            onDelete={() => remove.mutate(message.id)}
          />
        ))}
        <div ref={bottom} />
      </div>

      <div className="bc-pchat-typing" aria-live="polite">
        {visitorTyping ? `${current.customer_name} is typing…` : ''}
      </div>

      <form
        className="bc-pchat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSend || busy) return;
          if (body.trim() === '' && uploader.staged.length === 0) return;
          send.mutate();
        }}
      >
        {replyTo !== null && (
          <div className="bc-pchat-replying">
            <PcReplyQuote snippet={replyTo.body} />
            <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
              ×
            </button>
          </div>
        )}
        {uploader.staged.length > 0 && (
          <div className="bc-pchat-staged">
            {uploader.staged.map((staged) => (
              <span key={staged.localId}>
                <Icon name="paperclip" size={14} />
                {staged.filename}
                <small>{staged.status}</small>
                <button type="button" onClick={() => uploader.remove(staged.localId)} aria-label={`Remove ${staged.filename}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {!canSend ? (
          <p className="bc-pchat-banner">{en('pchat.banner.closed')}</p>
        ) : (
          <div className="bc-pchat-compose-box">
            <label className="bc-pchat-attach" title={en('pchat.composer.attach')}>
              <Icon name="paperclip" size={18} />
              <span className="sr-only">{en('pchat.composer.attach')}</span>
              <input
                type="file"
                multiple
                accept="image/*,video/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.zip"
                onChange={(event) => {
                  if (event.target.files !== null) uploader.addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
            <textarea
              aria-label={en('pchat.composer.placeholder')}
              placeholder={en('pchat.composer.placeholder')}
              value={body}
              rows={2}
              onChange={(event) => {
                setBody(event.target.value);
                pingTyping();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!busy && (body.trim() !== '' || uploader.staged.length > 0)) send.mutate();
                }
              }}
            />
            <button className="bc-pchat-send" disabled={busy || (body.trim() === '' && uploader.staged.length === 0)}>
              <Icon name="send" size={16} />
              <span>{en('pchat.composer.send')}</span>
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function StaffMessageRow({
  message,
  meId,
  nameOf,
  onReply,
  onDelete,
}: {
  message: PcStaffMessage;
  meId: string | null;
  nameOf: (userId: string | undefined) => string;
  onReply: () => void;
  onDelete: () => void;
}) {
  if (message.sender_kind === 'system') {
    // RAW system_meta, staff-side: {actor_username} plus either the two raw
    // statuses (status_changed / closed_by_customer) or the two member ULIDs
    // (claimed / reassigned). They are different shapes on purpose, so the
    // placeholders are filled per event rather than blindly.
    const meta = message.system_meta ?? {};
    const event = message.system_event ?? 'status_changed';
    const isStatus = event === 'status_changed' || event === 'closed_by_customer';
    const label = (raw: string | undefined) =>
      raw === undefined ? '—' : en(publicChatStatusLabelKey(raw as PublicChatStatus));
    return (
      <p className="bc-pchat-system">
        {interpolate(en(`pchat.systemStaff.${event}`), {
          actor: meta.actor_username ?? '—',
          from: isStatus ? label(meta.from) : nameOf(meta.from_user_id),
          to: isStatus ? label(meta.to) : nameOf(meta.to_user_id),
        })}
      </p>
    );
  }

  const mine = message.sender_kind === 'agent' && message.sender?.id === meId;
  // The agent sees exactly the label the customer sees for an agent row, so
  // there is no doubt about how the reply was signed externally.
  const who =
    message.sender_kind === 'visitor'
      ? (message.visitor_display_name ?? '')
      : (message.external_display_name ?? message.sender?.display_name ?? '');

  return (
    <article className={`bc-pchat-msg kind-${message.sender_kind}`} data-mine={mine}>
      <Avatar name={who === '' ? '?' : who} />
      <div className="bc-pchat-bubble">
        <p className="bc-pchat-author">
          {/* customer-controlled name: text node */}
          {who}
          <time>{pchatTime(message.created_at)}</time>
        </p>
        {message.reply_to !== null && <PcReplyQuote snippet={message.reply_to.snippet} />}
        {message.deleted ? (
          <p className="bc-pchat-deleted">{en('pchat.message.deleted')}</p>
        ) : (
          <>
            {message.body !== null && <p className="bc-pchat-body">{message.body}</p>}
            <PcAttachments attachments={message.attachments} />
          </>
        )}
        {!message.deleted && (
          <div className="bc-pchat-msg-actions">
            <button type="button" onClick={onReply}>
              {en('pchat.message.reply')}
            </button>
            <button type="button" onClick={onDelete}>
              Remove
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
