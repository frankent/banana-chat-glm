/**
 * FR-PCHAT-007/011/012/013/014 · API-210..216 — THE PUBLIC VISITOR PAGE.
 *
 * Route `/support/:code`, declared in App.tsx as a SIBLING of `/meet/:code`, at
 * the top level OUTSIDE both <EchoProvider> and <CallProvider>. That placement
 * is what structurally guarantees "no call, no meeting" on the client: nothing
 * in this subtree can reach a call context, so <CallButtons/> cannot mount even
 * by mistake. Do not move this route inside those providers.
 *
 * FOUR RULES THAT ARE NOT STYLE CHOICES:
 *  1. NO RAW `status`. The server only ever sends `status_public` here, and the
 *     page renders that — a customer must never learn support flagged their
 *     conversation `problem` (MANDATORY graft 1).
 *  2. NO `meta`, no assignee, no workspace id. The API does not send them; the
 *     page does not reconstruct them.
 *  3. THE 64-HEX CODE NEVER APPEARS IN A CHANNEL NAME (MANDATORY fix 12). The
 *     subscription is `private-public-chat.{room.id}`, which is exactly why
 *     API-210 returns the room ULID.
 *  4. customer_name / provider_name / bodies are attacker-controlled: they are
 *     rendered as TEXT NODES. No Markdown renderer, no dangerouslySetInnerHTML.
 *
 * A SIGNED-IN AGENT WHO OPENS THE LINK (FR-PCHAT-013 / MANDATORY graft 18): the
 * shared ApiClient attaches their bearer, the server answers `viewer:{kind:
 * 'member'}` and 403s a write. The composer is REPLACED with a sentence and a
 * link into Public Chat — never repurposed into "post as the customer".
 */
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@banana-chat/api-client';
import {
  isPublicChatCode,
  publicChatComposerBannerKey,
  publicChatComposerState,
} from '@banana-chat/chat-core';
import { t } from '@banana-chat/shared';
import type { Locale } from '@banana-chat/shared';
import { interpolate, mergeBySeq, pchat, pchatErrorMessage, pchatTime } from '../lib/public-chat';
import type { PcPublicMessage, PcVisitorView } from '../lib/public-chat';
import { useUploader } from '../hooks/useUploader';
import type { UploadDriver } from '../hooks/useUploader';
import { useSession } from '../state/session';
import { Banana, Icon } from '../components/Visual';
import { PcAttachments, PcPublicStatusPill, PcReplyQuote } from '../components/PublicChatParts';
import './meetings.css';
import './public-chat.css';

export function PublicChatVisitorPage() {
  const { code = '' } = useParams();
  return <VisitorChat key={code} code={code} />;
}

function VisitorChat({ code }: { code: string }) {
  // The bearer decides whether the server answers `viewer` at all, so the view
  // must not be fetched before session bootstrap has settled — otherwise a
  // signed-in agent gets a live composer and a 403 on their first send.
  const { status: sessionStatus } = useSession();
  const valid = isPublicChatCode(code);

  const view = useQuery({
    queryKey: ['pchat-visitor', code, sessionStatus],
    queryFn: () => pchat.visitorView(code),
    enabled: valid && sessionStatus !== 'loading',
    retry: false,
  });

  if (!valid || view.isError) {
    return (
      <Shell>
        <p role="alert">
          {!valid
            ? t('pchat.error.PCHAT_ROOM_NOT_FOUND', 'en')
            : view.error instanceof ApiError
              ? pchatErrorMessage(view.error)
              : // a transport failure is not a contract error, and the room's
                // locale is unknown before the first successful load — the same
                // English fallback PublicMeetingPage uses
                'Unable to open this conversation. Check your connection and try again.'}
        </p>
        <Link className="bc-meeting-back" to="/">
          Back to Banana Chat
        </Link>
      </Shell>
    );
  }
  if (view.data === undefined) {
    return (
      <Shell>
        <p role="status">…</p>
      </Shell>
    );
  }

  return <Conversation code={code} view={view.data} onReload={() => void view.refetch()} />;
}

function Shell({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <main className="bc-public-meeting bc-pchat-visitor">
      <div className="bc-meeting-wordmark">
        <Banana size={30} />
        <strong>
          banana<span>chat</span>
        </strong>
      </div>
      <section className="bc-pchat-visitor-card">
        {title !== undefined && <h1>{title}</h1>}
        {children}
      </section>
    </main>
  );
}

function Conversation({ code, view, onReload }: { code: string; view: PcVisitorView; onReload: () => void }) {
  const locale: Locale = view.room.locale === 'th' ? 'th' : 'en';
  const tr = useMemo(() => (key: string) => t(key, locale), [locale]);

  const [messages, setMessages] = useState<PcPublicMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [agentTyping, setAgentTyping] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  const seen = useRef(0);
  const clientMessageId = useRef(crypto.randomUUID());
  // held in refs: an inline callback in the deps would tear down and rebuild the
  // WebSocket on every parent render
  const reload = useRef(onReload);
  reload.current = onReload;

  // ---- transcript: API-211 is both the first load and the polling fallback ---
  // `after_seq` is read from a ref so the query key stays stable: every poll is
  // an incremental catch-up, and the same call gap-fills after a reconnect.
  const page = useQuery({
    queryKey: ['pchat-visitor-messages', code],
    queryFn: () => pchat.visitorMessages(code, seen.current > 0 ? { after_seq: seen.current } : { limit: 100 }),
    retry: false,
    // PublicMeetingPage's 10s precedent, tightened to the 5s the design names
    // for a chat surface. Off while the socket is up.
    refetchInterval: connected ? false : 5000,
  });

  useEffect(() => {
    if (page.data === undefined) return;
    setMessages((current) => {
      const merged = mergeBySeq(current, page.data.messages);
      const last = merged[merged.length - 1];
      if (last !== undefined && last.seq > seen.current) seen.current = last.seq;
      return merged;
    });
  }, [page.data]);

  // ---- realtime: this page builds its OWN Echo ------------------------------
  // EchoProvider cannot be reused: it is hardwired to tokenManager's access
  // token and gated on an authenticated session, and there is no session here.
  // The authorizer POSTs to API-215, which asserts the channel name by literal
  // string equality against `private-public-chat.{room.id}` and can therefore
  // never sign the -staff channel.
  const roomId = view.room.id;
  useEffect(() => {
    window.Pusher = Pusher;
    const echo = new Echo<'reverb'>({
      broadcaster: 'reverb',
      key: import.meta.env.VITE_REVERB_APP_KEY as string,
      wsHost: (import.meta.env.VITE_REVERB_HOST as string) ?? '127.0.0.1',
      wsPort: Number(import.meta.env.VITE_REVERB_PORT ?? 8088),
      wssPort: Number(import.meta.env.VITE_REVERB_PORT ?? 8088),
      forceTLS: false,
      enabledTransports: ['ws', 'wss'],
      authorizer: (channel: { name: string }) => ({
        authorize: (socketId: string, callback: (error: unknown, response: unknown) => void) => {
          // `channel.name` is already `private-public-chat.<ulid>`; pass it
          // through verbatim — the server compares the exact string.
          void pchat
            .visitorBroadcastAuth(code, socketId, channel.name)
            .then((response) => callback(false, response))
            .catch((err: unknown) => callback(true as never, err as never));
        },
      }),
    });

    const connection = echo.connector.pusher.connection;
    const onState = (states: { current: string }) => setConnected(states.current === 'connected');
    connection.bind('state_change', onState);
    setConnected(connection.state === 'connected');

    const channel = echo.private(`public-chat.${roomId}`);
    channel.listen('.public_chat.message.created', (envelope: { data?: { message?: PcPublicMessage } }) => {
      const message = envelope.data?.message;
      if (message === undefined) return;
      setMessages((current) => mergeBySeq(current, [message]));
      if (message.seq > seen.current) seen.current = message.seq;
    });
    channel.listen('.public_chat.message.deleted', (envelope: { data?: { message_id?: string } }) => {
      const id = envelope.data?.message_id;
      if (id === undefined) return;
      setMessages((current) =>
        current.map((message) => (message.id === id ? { ...message, deleted: true, body: null, attachments: [] } : message)),
      );
    });
    // EVT-081 visitor variant: {room:{id,status_public,can_send}} — no assignee,
    // no raw status. Re-read API-210 rather than patching a partial room in.
    channel.listen('.public_chat.room.changed', () => reload.current());

    let clear: ReturnType<typeof setTimeout> | null = null;
    channel.listen('.public_chat.typing', (envelope: { data?: { sender_kind?: string } }) => {
      if (envelope.data?.sender_kind !== 'agent') return;
      setAgentTyping(true);
      if (clear !== null) clearTimeout(clear);
      clear = setTimeout(() => setAgentTyping(false), 4000);
    });

    return () => {
      if (clear !== null) clearTimeout(clear);
      connection.unbind('state_change', onState);
      echo.disconnect();
    };
  }, [code, roomId]);

  // one catch-up fetch the moment the socket comes up, so a gap opened while
  // the connection was down is closed without waiting for the next poll tick
  const refetch = useRef(page.refetch);
  refetch.current = page.refetch;
  useEffect(() => {
    if (connected) void refetch.current();
  }, [connected]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // ---- uploads: API-213/214, room-scoped, no uploader identity --------------
  const driver: UploadDriver = useMemo(
    () => ({
      create: (input) => pchat.visitorUpload(code, input),
      complete: (attachmentId, parts) => pchat.visitorCompleteUpload(code, attachmentId, parts),
      // deliberately no `poll`: there is no visitor read-back endpoint, and the
      // transcript re-renders the attachment ready on the next message fetch
    }),
    [code],
  );
  const uploader = useUploader('', driver);

  const typingSent = useRef(0);
  function pingTyping() {
    const now = Date.now();
    if (now - typingSent.current < 3000) return;
    typingSent.current = now;
    void pchat.visitorTyping(code, true).catch(() => {});
  }

  const send = useMutation({
    mutationFn: () => {
      const attachmentIds = uploader.staged
        .filter((staged) => staged.attachmentId !== null && staged.status !== 'error')
        .map((staged) => staged.attachmentId as string);
      return pchat.visitorSend(code, {
        client_message_id: clientMessageId.current,
        body: body.trim() === '' ? undefined : body.trim(),
        attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
      });
    },
    // transport and 5xx only: PCHAT_SIGNED_IN / PCHAT_ROOM_CLOSED / PCHAT_DISABLED
    // will not change on a retry, and retrying a 429 spends what is left of the
    // per-code write budget
    retry: (attempt, err) => attempt < 1 && !(err instanceof ApiError && err.status < 500),
    onSuccess: (result) => {
      setMessages((current) => mergeBySeq(current, [result.message]));
      if (result.message.seq > seen.current) seen.current = result.message.seq;
      setBody('');
      setError('');
      uploader.clear();
      // a new key only after the server confirmed this one — a retry of the
      // SAME message must replay, not create a second row
      clientMessageId.current = crypto.randomUUID();
    },
    onError: (err) => {
      setError(pchatErrorMessage(err, locale));
      if (err instanceof ApiError && [403, 409, 410, 503].includes(err.status)) reload.current();
    },
  });

  // THE BANNER'S SOURCE OF TRUTH. `closed_reason` is informational only; the
  // composer state also decides whether the input renders at all, so the two
  // cannot disagree on screen.
  const composerState = publicChatComposerState({
    feature_enabled: view.feature_enabled,
    status_public: view.room.status_public,
    viewer: view.viewer,
    expires_at: view.room.expires_at,
  });
  const bannerKey = publicChatComposerBannerKey(composerState);
  const busy = send.isPending || uploader.staged.some((s) => s.status === 'creating' || s.status === 'uploading');

  return (
    <main className="bc-public-meeting bc-pchat-visitor" lang={locale}>
      <div className="bc-meeting-wordmark">
        <Banana size={30} />
        <strong>
          banana<span>chat</span>
        </strong>
      </div>

      <section className="bc-pchat-visitor-card">
        <header className="bc-pchat-visitor-head">
          <div>
            <span className="bc-eyebrow">{tr('pchat.visitor.title').toUpperCase()}</span>
            {/* provider_name is partner-supplied — text node */}
            <h1>{interpolate(tr('pchat.visitor.with'), { provider: view.room.provider_name })}</h1>
            <p className="bc-caption">{view.room.customer_name}</p>
          </div>
          {/* status_public ONLY — `problem` never reaches this page */}
          <PcPublicStatusPill status={view.room.status_public} locale={locale} />
        </header>

        <div className="bc-pchat-visitor-log">
          {messages.length === 0 && <p className="bc-pchat-empty">{tr('pchat.visitor.empty')}</p>}
          {messages.map((message) => (
            <VisitorRow key={message.id} message={message} locale={locale} />
          ))}
          <div ref={bottom} />
        </div>

        <div className="bc-pchat-typing" aria-live="polite">
          {agentTyping ? interpolate(tr('pchat.visitor.with'), { provider: view.room.provider_name }) + ' …' : ''}
          {!connected && page.isFetching ? tr('pchat.visitor.reconnecting') : ''}
        </div>

        {error !== '' && (
          <p role="alert" className="bc-pchat-alert">
            {error}
          </p>
        )}

        {bannerKey !== null ? (
          <p className="bc-pchat-banner" role="status">
            {composerState === 'signed_in'
              ? interpolate(tr(bannerKey), { name: view.viewer?.display_name ?? '' })
              : tr(bannerKey)}
            {composerState === 'signed_in' && (
              <>
                {' '}
                <Link to={`/public-chat/${view.room.id}`}>{tr('pchat.room.openInPublicChat')}</Link>
              </>
            )}
          </p>
        ) : (
          <form
            className="bc-pchat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              if (body.trim() === '' && uploader.staged.length === 0) return;
              send.mutate();
            }}
          >
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
            <div className="bc-pchat-compose-box">
              <label className="bc-pchat-attach" title={tr('pchat.composer.attach')}>
                <Icon name="paperclip" size={18} />
                <span className="sr-only">{tr('pchat.composer.attach')}</span>
                {/* chat + file + video only — there is no call or meeting here */}
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
                aria-label={tr('pchat.composer.placeholder')}
                placeholder={tr('pchat.composer.placeholder')}
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
                <span>{tr('pchat.composer.send')}</span>
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}

function VisitorRow({ message, locale }: { message: PcPublicMessage; locale: Locale }) {
  const tr = (key: string) => t(key, locale);

  if (message.sender_kind === 'system') {
    // VISITOR-SAFE sentences: no actor, no raw status. system_meta arrives
    // already projected through status_public, and the catalog strings carry no
    // placeholders for it.
    return <p className="bc-pchat-system">{tr(`pchat.system.${message.system_event ?? 'status_changed'}`)}</p>;
  }

  const mine = message.sender_kind === 'visitor';
  return (
    <article className={`bc-pchat-msg kind-${message.sender_kind}`} data-mine={mine}>
      <div className="bc-pchat-bubble">
        <p className="bc-pchat-author">
          {/* `display_name` is assembled server-side: the customer's own name, or
              "provider name (admin username)" for an agent (FR-PCHAT-014). */}
          {mine ? tr('pchat.visitor.you') : (message.display_name ?? '')}
          <time>{pchatTime(message.created_at)}</time>
        </p>
        {message.reply_to !== null && <PcReplyQuote snippet={message.reply_to.snippet} locale={locale} />}
        {message.deleted ? (
          <p className="bc-pchat-deleted">{tr('pchat.message.deleted')}</p>
        ) : (
          <>
            {message.body !== null && <p className="bc-pchat-body">{message.body}</p>}
            <PcAttachments attachments={message.attachments} />
          </>
        )}
      </div>
    </article>
  );
}
