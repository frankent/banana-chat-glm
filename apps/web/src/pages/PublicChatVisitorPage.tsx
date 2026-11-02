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
import { interpolate, mergeBySeq, pchat, pchatErrorMessage, pchatTime, readGuestToken, saveGuestToken } from '../lib/public-chat';
import type { PcPublicMessage, PcVisitorView } from '../lib/public-chat';
import { useUploader } from '../hooks/useUploader';
import type { UploadDriver } from '../hooks/useUploader';
import { useSession } from '../state/session';
import { PublicChatMeeting } from '../components/PublicChatMeeting';
import { Banana, Icon } from '../components/Visual';
import { PcDialog, PublicChatPasswordField } from '../components/PublicChatUi';
import { PcAttachments, PcPublicStatusPill, PcReplyQuote } from '../components/PublicChatParts';
import './meetings.css';
import './public-chat.css';

const LOCALE_KEY = 'bc.pchat.locale';
function readLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    return v === 'th' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

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

  const [guestToken, setGuestToken] = useState<string | null>(() => readGuestToken(code));
  const [override, setOverride] = useState<Locale | null>(readLocale);
  const [ended, setEnded] = useState(false);
  const [welcome, setWelcome] = useState<{ name: string; saved: boolean } | null>(null);
  const view = useQuery({
    queryKey: ['pchat-visitor', code, sessionStatus, guestToken],
    queryFn: () => pchat.visitorView(code, guestToken),
    enabled: valid && sessionStatus !== 'loading',
    retry: false,
  });
  const roomLocale: Locale | null = view.data ? (view.data.room.locale === 'th' ? 'th' : 'en') : null;
  const locale: Locale = override ?? roomLocale ?? 'en';
  const tr = (key: string) => t(key, locale);
  function setLocale(next: Locale) {
    setOverride(next);
    try {
      localStorage.setItem(LOCALE_KEY, next);
    } catch {
      /* per-visit only */
    }
  }
  const lost = () => {
    saveGuestToken(code, null);
    setGuestToken(null);
  };

  if (!valid || view.isError) {
    const status = view.error instanceof ApiError ? view.error.status : null;
    const expired = status === 410;
    const invalid = !valid || status === 404;
    return (
      <Shell locale={locale} onLocale={setLocale}>
        <div className="pc-card pc-form pc-gate" style={{ margin: '0 auto' }}>
          <h1 className="pc-h2">{tr(expired ? 'pchat.state.expired' : invalid ? 'pchat.state.invalid' : 'pchat.state.networkError')}</h1>
          {!invalid && !expired && (
            <button type="button" className="pc-button primary" onClick={() => void view.refetch()}>
              {tr('pchat.action.retry')}
            </button>
          )}
          <Link className="pc-button" to="/">
            Banana Chat
          </Link>
        </div>
      </Shell>
    );
  }
  if (view.data === undefined) {
    return (
      <Shell locale={locale} onLocale={setLocale}>
        <div className="pc-card pc-skeleton pc-gate" style={{ margin: '0 auto' }} role="status" aria-label={tr('pchat.state.loading')}>
          <i />
          <i />
          <i />
        </div>
      </Shell>
    );
  }

  if (view.data.requires_password === true) {
    return (
      <PasswordGate
        code={code}
        view={view.data}
        locale={locale}
        onLocale={setLocale}
        ended={ended}
        onJoined={(token, name) => {
          saveGuestToken(code, token);
          setEnded(false);
          setWelcome({ name, saved: readGuestToken(code) === token });
          setGuestToken(token);
        }}
        onStale={() => {
          if (guestToken !== null) {
            lost();
            setEnded(true);
          }
        }}
      />
    );
  }

  return (
    <Conversation
      code={code}
      view={view.data}
      locale={locale}
      onLocale={setLocale}
      guestToken={guestToken}
      welcome={welcome}
      onDismissWelcome={() => setWelcome(null)}
      onReload={() => void view.refetch()}
      onForget={() => {
        lost();
        setWelcome(null);
      }}
      onGuestLost={() => {
        lost();
        setEnded(true);
      }}
    />
  );
}

function LocaleSwitch({ locale, onLocale }: { locale: Locale; onLocale: (l: Locale) => void }) {
  return (
    <div className="pc-lang" role="group" aria-label={t('pchat.action.language', locale)}>
      {(['en', 'th'] as const).map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={locale === l} onClick={() => onLocale(l)}>
          {l === 'en' ? 'EN' : 'ไทย'}
        </button>
      ))}
    </div>
  );
}

function Topbar({ locale, onLocale, children }: { locale: Locale; onLocale: (l: Locale) => void; children?: ReactNode }) {
  return (
    <div className="pc-topbar">
      <div className="pc-brand">
        <Banana size={28} />
        <strong>
          banana<span>chat</span>
        </strong>
      </div>
      <div className="pc-row">
        {children}
        <LocaleSwitch locale={locale} onLocale={onLocale} />
      </div>
    </div>
  );
}

function Shell({ children, locale, onLocale }: { children: ReactNode; locale: Locale; onLocale: (l: Locale) => void }) {
  return (
    <main className="bc-pchat-surface pc-page" lang={locale}>
      <Topbar locale={locale} onLocale={onLocale} />
      <div className="pc-gate-wrap">{children}</div>
    </main>
  );
}

function PasswordGate({
  code,
  view,
  locale,
  onLocale,
  ended,
  onJoined,
  onStale,
}: {
  code: string;
  view: PcVisitorView;
  locale: Locale;
  onLocale: (l: Locale) => void;
  ended: boolean;
  onJoined: (token: string, name: string) => void;
  onStale: () => void;
}) {
  const tr = (key: string) => t(key, locale);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 40;

  // a token the server no longer honours (password rotated, re-entered elsewhere)
  useEffect(onStale, [onStale]);

  async function submit() {
    setTouched(true);
    if (!nameOk || password === '') return;
    setBusy(true);
    setError('');
    try {
      const joined = await pchat.guestJoin(code, { password, display_name: name.trim() });
      onJoined(joined.guest_token, joined.guest.display_name);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? tr('pchat.gate.tooManyAttempts') : pchatErrorMessage(e, locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell locale={locale} onLocale={onLocale}>
      <form
        className="pc-card pc-form pc-gate"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="pc-lock" aria-hidden="true">
          <Icon name="lock" size={22} />
        </div>
        {/* customer_name is partner/member-supplied — text node */}
        <h1 className="pc-h1">{view.room.customer_name}</h1>
        <p className="pc-help">
          {tr('pchat.gate.title')} {tr('pchat.gate.noAccount')}
        </p>
        {ended && (
          <p className="pc-note" role="status">
            {tr('pchat.gate.sessionEnded')}
          </p>
        )}
        <div className="pc-field-group">
          <label className="pc-label" htmlFor="pc-gate-name">
            {tr('pchat.gate.name')}
          </label>
          <input
            id="pc-gate-name"
            className="pc-field"
            maxLength={40}
            autoComplete="nickname"
            autoFocus
            value={name}
            aria-invalid={touched && !nameOk ? true : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="pc-help">{tr('pchat.gate.hint')}</p>
          {touched && !nameOk && (
            <p className="pc-field-error" role="alert">
              {tr('pchat.gate.nameInvalid')}
            </p>
          )}
        </div>
        <PublicChatPasswordField
          value={password}
          onChange={setPassword}
          locale={locale}
          label={tr('pchat.gate.password')}
          autoComplete="current-password"
          error={touched && password === '' ? tr('pchat.gate.passwordRequired') : undefined}
        />
        {error && (
          <p className="pc-alert" role="alert">
            {error}
          </p>
        )}
        <button className="pc-button primary lg" disabled={busy}>
          {busy ? tr('pchat.gate.joining') : tr('pchat.gate.submit')}
        </button>
        <details className="pc-disclosure">
          <summary>{tr('pchat.gate.howReturningWorks')}</summary>
          <p className="pc-help">{tr('pchat.gate.reentryDetail')}</p>
          <p className="pc-help">{tr('pchat.gate.rememberHint')}</p>
        </details>
      </form>
    </Shell>
  );
}

function Conversation({
  code,
  view,
  locale,
  onLocale,
  guestToken,
  welcome,
  onDismissWelcome,
  onReload,
  onForget,
  onGuestLost,
}: {
  code: string;
  view: PcVisitorView;
  locale: Locale;
  onLocale: (l: Locale) => void;
  guestToken: string | null;
  welcome: { name: string; saved: boolean } | null;
  onDismissWelcome: () => void;
  onReload: () => void;
  onForget: () => void;
  onGuestLost: () => void;
}) {
  const tr = useMemo(() => (key: string) => t(key, locale), [locale]);

  const [messages, setMessages] = useState<PcPublicMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [agentTyping, setAgentTyping] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const [unread, setUnread] = useState(0);
  const [videoHost, setVideoHost] = useState<HTMLElement | null>(null);
  const [videoOn, setVideoOn] = useState(false);
  const [tab, setTab] = useState<'video' | 'chat'>('video');
  const [forgetOpen, setForgetOpen] = useState(false);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const seen = useRef(0);
  const clientMessageId = useRef(crypto.randomUUID());
  // held in refs: an inline callback in the deps would tear down and rebuild the
  // WebSocket on every parent render
  const reload = useRef(onReload);
  reload.current = onReload;
  const guestTokenRef = useRef(guestToken);
  guestTokenRef.current = guestToken;
  const guestLost = useRef(onGuestLost);
  guestLost.current = onGuestLost;

  // ---- transcript: API-211 is both the first load and the polling fallback ---
  // `after_seq` is read from a ref so the query key stays stable: every poll is
  // an incremental catch-up, and the same call gap-fills after a reconnect.
  const page = useQuery({
    queryKey: ['pchat-visitor-messages', code],
    queryFn: () => pchat.visitorMessages(code, seen.current > 0 ? { after_seq: seen.current } : { limit: 100 }, guestToken),
    retry: false,
    // PublicMeetingPage's 10s precedent, tightened to the 5s the design names
    // for a chat surface. Off while the socket is up.
    refetchInterval: connected ? false : 5000,
  });

  useEffect(() => {
    if (page.error instanceof ApiError && page.error.code === 'PCHAT_GUEST_REQUIRED') guestLost.current();
  }, [page.error]);

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
            .visitorBroadcastAuth(code, socketId, channel.name, guestTokenRef.current)
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

  const prevCount = useRef(0);
  useEffect(() => {
    const added = messages.length - prevCount.current;
    prevCount.current = messages.length;
    if (added <= 0) return;
    const last = messages[messages.length - 1];
    const guestId = view.viewer?.kind === 'guest' ? (view.viewer.guest_id ?? null) : null;
    const own = last?.sender_kind === 'visitor' && (guestId === null ? last.guest_id == null : last.guest_id === guestId);
    if (nearBottom.current || own || prevCount.current === added) {
      bottom.current?.scrollIntoView({ block: 'end' });
      setUnread(0);
    } else setUnread((n) => n + added);
  }, [messages, view.viewer]);

  // ---- uploads: API-213/214, room-scoped, no uploader identity --------------
  const driver: UploadDriver = useMemo(
    () => ({
      create: (input) => pchat.visitorUpload(code, input, guestToken),
      complete: (attachmentId, parts) => pchat.visitorCompleteUpload(code, attachmentId, parts, guestToken),
      // deliberately no `poll`: there is no visitor read-back endpoint, and the
      // transcript re-renders the attachment ready on the next message fetch
    }),
    [code, guestToken],
  );
  const uploader = useUploader('', driver);

  const typingSent = useRef(0);
  function pingTyping() {
    const now = Date.now();
    if (now - typingSent.current < 3000) return;
    typingSent.current = now;
    void pchat.visitorTyping(code, true, guestToken).catch(() => {});
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
      }, guestToken);
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
    viewer: view.viewer?.kind === 'member' ? view.viewer : null,
    expires_at: view.room.expires_at,
  });
  const bannerKey = publicChatComposerBannerKey(composerState);
  const busy = send.isPending || uploader.staged.some((s) => s.status === 'creating' || s.status === 'uploading');

  const isGuest = view.viewer?.kind === 'guest';
  const guestName = view.viewer?.display_name ?? '';
  const guestId = isGuest ? (view.viewer?.guest_id ?? null) : null;
  const title = isGuest ? view.room.customer_name : interpolate(tr('pchat.visitor.with'), { provider: view.room.provider_name });

  const chatPane = (
    <div className="pc-stage-chat">
      <div
        ref={log}
        className="pc-log"
        role="log"
        aria-label={tr('pchat.chat.transcript')}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (nearBottom.current) setUnread(0);
        }}
      >
        <div className="pc-log-inner">
          {messages.length === 0 && (
            <div className="pc-empty">
              <Banana size={40} />
              <strong className="pc-h3">{isGuest ? tr('pchat.chat.emptyTitle') : tr('pchat.visitor.empty')}</strong>
              {isGuest && <p>{interpolate(tr('pchat.chat.emptyBody'), { room: view.room.customer_name })}</p>}
            </div>
          )}
          {messages.map((message) => (
            <VisitorRow key={message.id} message={message} locale={locale} guestId={guestId} />
          ))}
          <div ref={bottom} />
        </div>
        {unread > 0 && (
          <button
            type="button"
            className="pc-button primary pc-jump"
            onClick={() => {
              bottom.current?.scrollIntoView({ block: 'end' });
              setUnread(0);
            }}
          >
            {unread === 1 ? tr('pchat.chat.newMessage') : interpolate(tr('pchat.chat.newMessages'), { count: String(unread) })}
          </button>
        )}
      </div>

      <div className="pc-composer-foot" aria-live="polite" style={{ padding: '0 16px', minHeight: 20 }}>
        {agentTyping ? interpolate(tr('pchat.visitor.with'), { provider: view.room.provider_name }) + ' …' : ''}
      </div>

      {error !== '' && (
        <p role="alert" className="pc-alert" style={{ margin: '0 16px 8px' }}>
          {error}
        </p>
      )}

      {bannerKey !== null ? (
        <p className="pc-banner" role="status">
          <span>
            {composerState === 'signed_in' ? interpolate(tr(bannerKey), { name: view.viewer?.display_name ?? '' }) : tr(bannerKey)}
            {composerState === 'signed_in' && (
              <>
                {' '}
                <Link to={`/public-chat/${view.room.id}`}>{tr('pchat.room.openInPublicChat')}</Link>
              </>
            )}
          </span>
        </p>
      ) : (
        <form
          className="pc-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (body.trim() === '' && uploader.staged.length === 0) return;
            send.mutate();
          }}
        >
          {uploader.staged.length > 0 && (
            <div className="pc-staged">
              {uploader.staged.map((staged) => (
                <span key={staged.localId}>
                  <Icon name="paperclip" size={14} />
                  {staged.filename}
                  <small>{staged.status}</small>
                  <button
                    type="button"
                    className="pc-button pc-icon-button"
                    style={{ minHeight: 36, width: 36, minWidth: 36, height: 36 }}
                    onClick={() => uploader.remove(staged.localId)}
                    aria-label={`${tr('pchat.action.remove')} ${staged.filename}`}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="pc-composer-box">
            <label className="pc-attach">
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
              ref={composer}
              className="pc-field"
              aria-label={tr('pchat.composer.placeholder')}
              placeholder={tr('pchat.composer.placeholder')}
              value={body}
              rows={1}
              onChange={(event) => {
                setBody(event.target.value);
                pingTyping();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!busy && (body.trim() !== '' || uploader.staged.length > 0)) send.mutate();
                }
              }}
            />
            <button className="pc-button primary pc-icon-button" aria-label={tr('pchat.composer.send')} disabled={busy || (body.trim() === '' && uploader.staged.length === 0)}>
              <Icon name="send" size={18} />
            </button>
          </div>
        </form>
      )}
    </div>
  );

  return (
    <main className="bc-pchat-surface pc-page" lang={locale}>
      <Topbar locale={locale} onLocale={onLocale} />
      <section className="pc-chat">
        <header className="pc-head">
          <div className="pc-head-who">
            {/* provider_name / customer_name are partner-supplied — text nodes */}
            <h1 className="pc-h2">{title}</h1>
            <p>
              {isGuest && <span>{interpolate(tr('pchat.chat.asGuest'), { name: guestName })}</span>}
              <span>
                <span className={`pc-dot${connected ? '' : ' off'}`} aria-hidden="true" />{' '}
                {connected ? tr('pchat.chat.connected') : tr('pchat.chat.reconnecting')}
              </span>
            </p>
          </div>
          <div className="pc-row">
            {/* status_public ONLY — `problem` never reaches this page */}
            <PcPublicStatusPill status={view.room.status_public} locale={locale} />
            {view.has_meeting === true && guestToken !== null && (
              <PublicChatMeeting
                title={view.room.customer_name}
                locale={locale}
                name={guestName}
                host={videoHost}
                onActiveChange={(on) => {
                  setVideoOn(on);
                  if (on) setTab('video');
                }}
                join={(resume) => pchat.meetingJoin(code, guestToken, resume)}
                leave={(token) => pchat.meetingLeave(code, token)}
              />
            )}
            {isGuest && guestToken !== null && (
              <details className="pc-menu">
                <summary className="pc-button pc-icon-button" aria-label={tr('pchat.chat.details')}>
                  <Icon name="more" size={18} />
                </summary>
                <div className="pc-menu-pop pc-card">
                  <p className="pc-help" style={{ padding: 8 }}>
                    {tr('pchat.gate.remembered')}
                  </p>
                  <button type="button" className="pc-button" onClick={() => setForgetOpen(true)}>
                    {tr('pchat.gate.forgetDevice')}
                  </button>
                </div>
              </details>
            )}
          </div>
        </header>

        {welcome && (
          <div className="pc-banner" role="status">
            <span>
              {interpolate(tr('pchat.gate.joined'), { name: welcome.name })}{' '}
              {welcome.saved ? tr('pchat.gate.remembered') + '.' : tr('pchat.gate.storageUnavailable')}
            </span>
            <button type="button" className="pc-button" onClick={onDismissWelcome}>
              {tr('pchat.action.dismiss')}
            </button>
          </div>
        )}

        <div className="pc-stage" data-call={videoOn} data-tab={tab}>
          <div className="pc-stage-tabs" role="group">
            <button type="button" className="pc-button pc-chip" aria-pressed={tab === 'video'} onClick={() => setTab('video')}>
              {tr('pchat.meeting.videoTab')}
            </button>
            <button type="button" className="pc-button pc-chip" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>
              {tr('pchat.meeting.chatTab')}
            </button>
          </div>
          <div className="pc-stage-panes">
            <div ref={setVideoHost} className="pc-stage-video" />
            {chatPane}
          </div>
        </div>
      </section>

      <PcDialog
        open={forgetOpen}
        onClose={() => setForgetOpen(false)}
        locale={locale}
        title={tr('pchat.gate.forgetDevice')}
        footer={
          <>
            <button type="button" className="pc-button" onClick={() => setForgetOpen(false)}>
              {tr('pchat.action.cancel')}
            </button>
            <button
              type="button"
              className="pc-button primary"
              onClick={() => {
                setForgetOpen(false);
                onForget();
              }}
            >
              {tr('pchat.gate.forgetDevice')}
            </button>
          </>
        }
      >
        <p className="pc-help">{tr('pchat.gate.forgetHint')}</p>
      </PcDialog>
    </main>
  );
}

function VisitorRow({ message, locale, guestId }: { message: PcPublicMessage; locale: Locale; guestId: string | null }) {
  const tr = (key: string) => t(key, locale);

  if (message.sender_kind === 'system') {
    // VISITOR-SAFE sentences: no actor, no raw status. system_meta arrives
    // already projected through status_public, and the catalog strings carry no
    // placeholders for it.
    return <p className="pc-system">{tr(`pchat.system.${message.system_event ?? 'status_changed'}`)}</p>;
  }

  const mine = message.sender_kind === 'visitor' && (guestId === null ? message.guest_id == null : message.guest_id === guestId);
  const staff = message.sender_kind === 'agent';
  const name = mine ? tr('pchat.visitor.you') : (message.display_name ?? '');
  return (
    <article className="pc-msg" data-mine={mine} data-staff={staff}>
      {!mine && (
        <div className="pc-avatar" aria-hidden="true">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </div>
      )}
      <div className="pc-msg-col">
        <div className="pc-meta">
          {/* `display_name` is assembled server-side (FR-PCHAT-014); render as text */}
          <strong>{name}</strong>
          {staff && <span className="pc-badge staff">{tr('pchat.chat.staff')}</span>}
          <time>{pchatTime(message.created_at)}</time>
        </div>
        <div className="pc-bubble">
          {message.reply_to !== null && <PcReplyQuote snippet={message.reply_to.snippet} locale={locale} />}
          {message.deleted ? (
            <span className="pc-deleted">{tr('pchat.message.deleted')}</span>
          ) : (
            <>
              {message.body !== null && <span>{message.body}</span>}
              <PcAttachments attachments={message.attachments} />
            </>
          )}
        </div>
      </div>
    </article>
  );
}
