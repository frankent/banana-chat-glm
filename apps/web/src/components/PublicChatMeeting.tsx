import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MeetingJoin, Locale } from '@banana-chat/shared';
import { t } from '@banana-chat/shared';
import { Icon } from './Visual';
import { PublicChatPreJoin } from './PublicChatUi';
import '../components/calls/calls.css';

const MediaPanel = lazy(() => import('./calls/MediaPanel'));

interface Props {
  title: string;
  locale: Locale;
  /** Name shown in the pre-join sheet. */
  name: string;
  join: (resume?: string) => Promise<MeetingJoin>;
  leave: (participantToken: string) => Promise<unknown>;
  /** Stable element to embed the video into; without it the panel floats as an overlay. */
  host?: HTMLElement | null;
  onActiveChange?: (active: boolean) => void;
}

/** FR-PCHAT-042/043 — pre-join sheet + media panel for a group room's meeting; serves guests and members. */
export function PublicChatMeeting({ title, locale, name, join, leave, host, onActiveChange }: Props) {
  const [active, setActive] = useState<MeetingJoin | null>(null);
  const [media, setMedia] = useState({ microphoneEnabled: true, cameraEnabled: false });
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeRef = useRef<MeetingJoin | null>(null);
  const closeMedia = useRef<(() => void) | null>(null);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const notifyRef = useRef(onActiveChange);
  notifyRef.current = onActiveChange;

  useEffect(
    () => () => {
      closeMedia.current?.();
      const current = activeRef.current;
      activeRef.current = null;
      if (current) void Promise.resolve(leaveRef.current(current.participant_token)).catch(() => {});
      notifyRef.current?.(false);
    },
    [],
  );

  async function start(choice: { microphoneEnabled: boolean; cameraEnabled: boolean }) {
    if (busy || active) return;
    setBusy(true);
    setError('');
    try {
      const credentials = await join();
      activeRef.current = credentials;
      setMedia(choice);
      setActive(credentials);
      setSheet(false);
      notifyRef.current?.(true);
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
    notifyRef.current?.(false);
    if (current) await Promise.resolve(leave(current.participant_token)).catch(() => {});
  }

  const panel = active && (
    <Suspense fallback={<p role="status">{t('pchat.meeting.connecting', locale)}</p>}>
      <MediaPanel
        id={active.meeting.id}
        title={title}
        kind="video"
        url={active.url}
        token={active.token}
        presentation={host ? 'embedded' : 'overlay'}
        initialMedia={media}
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
  );

  return (
    <>
      <button
        type="button"
        className="pc-button primary"
        disabled={active !== null}
        onClick={() => {
          setError('');
          setSheet(true);
        }}
      >
        <Icon name="video" size={18} />
        {active ? t('pchat.meeting.inCall', locale) : t('pchat.meeting.join', locale)}
      </button>
      <PublicChatPreJoin
        open={sheet && active === null}
        room={title}
        name={name}
        locale={locale}
        busy={busy}
        error={error}
        onCancel={() => setSheet(false)}
        onJoin={(choice) => void start(choice)}
      />
      {panel && (host ? createPortal(panel, host) : panel)}
    </>
  );
}
