import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { MeetingJoin, Locale } from '@banana-chat/shared';
import { t } from '@banana-chat/shared';
import { Icon } from './Visual';
import '../components/calls/calls.css';

const MediaPanel = lazy(() => import('./calls/MediaPanel'));

interface Props {
  title: string;
  locale: Locale;
  join: (resume?: string) => Promise<MeetingJoin>;
  leave: (participantToken: string) => Promise<unknown>;
}

/** FR-PCHAT-042 — join button + media panel for a group room's meeting; the same component serves guests and members. */
export function PublicChatMeeting({ title, locale, join, leave }: Props) {
  const [active, setActive] = useState<MeetingJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeRef = useRef<MeetingJoin | null>(null);
  const closeMedia = useRef<(() => void) | null>(null);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  useEffect(
    () => () => {
      closeMedia.current?.();
      const current = activeRef.current;
      activeRef.current = null;
      if (current) void Promise.resolve(leaveRef.current(current.participant_token)).catch(() => {});
    },
    [],
  );

  async function start() {
    if (busy || active) return;
    setBusy(true);
    setError('');
    try {
      const credentials = await join();
      activeRef.current = credentials;
      setActive(credentials);
    } catch {
      setError(t('pchat.meeting.failed', locale));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    closeMedia.current?.();
    const current = activeRef.current;
    activeRef.current = null;
    setActive(null);
    if (current) await Promise.resolve(leave(current.participant_token)).catch(() => {});
  }

  return (
    <>
      <button type="button" className="bc-primary" disabled={busy || active !== null} onClick={() => void start()}>
        <Icon name="video" size={18} />
        {busy ? t('pchat.meeting.connecting', locale) : t('pchat.meeting.join', locale)}
      </button>
      {error && <p role="alert">{error}</p>}
      {active && (
        <Suspense fallback={<p role="status">{t('pchat.meeting.connecting', locale)}</p>}>
          <MediaPanel
            id={active.meeting.id}
            title={title}
            kind="video"
            url={active.url}
            token={active.token}
            canEnd={false}
            canMinimize={false}
            onLeave={() => void stop()}
            registerDisconnect={(fn) => {
              closeMedia.current = fn;
            }}
            refreshCredentials={async () => {
              const credentials = await join(activeRef.current?.participant_token);
              if (activeRef.current) activeRef.current.participant_token = credentials.participant_token;
              return credentials;
            }}
            checkActive={async () => true}
          />
        </Suspense>
      )}
    </>
  );
}
