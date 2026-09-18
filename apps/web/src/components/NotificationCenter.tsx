import { useEffect, useRef, useState } from 'react';
import { desktopNotificationPermission, requestDesktopNotificationPermission } from '../lib/desktop-notification';
import { currentWebPushStatus, enableWebPush, lastWebPushResult, type EnableWebPushResult } from '../lib/web-push';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InAppNotification } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { unlockNotificationAudio, playNotificationAudio } from '../lib/notification-audio';
import { Icon } from './Visual';
import { useSession } from '../state/session';

/**
 * FR-NOTI-006 — in-app notification center (API-073). Feed rows are event
 * pointers, not messages: mention / added to room / session revoked.
 */
export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { currentWorkspace, me } = useSession();
  const [savingSound, setSavingSound] = useState(false);
  const [soundError, setSoundError] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const slug = currentWorkspace?.workspace.slug;
  const panelRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ['notifications', slug],
    queryFn: () => endpoints.myNotifications(slug!),
    enabled: slug !== undefined,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const settings = useQuery({queryKey: ['notification-settings', me?.id], queryFn: () => endpoints.me(), enabled: me !== null});
  // TC-WEB-030 — the browser prompt must follow an explicit press, never page load,
  // so this is deliberately a button and not an effect.
  const [desktopPermission, setDesktopPermission] = useState<NotificationPermission | 'unsupported'>(
    () => desktopNotificationPermission(),
  );
  // Web Push status is separate from the popup permission: a desktop tab can show
  // popups with no push setup at all, while a phone needs the full PWA + push path.
  const [pushStatus, setPushStatus] = useState(() => currentWebPushStatus());
  const [pushResult, setPushResult] = useState<EnableWebPushResult | null>(() => lastWebPushResult());
  const [enabling, setEnabling] = useState(false);
  // EchoProvider's silent re-registration can land after this component mounted,
  // and permission can change in another tab, so re-read both when the panel opens
  // rather than trusting whatever was true at mount.
  useEffect(() => {
    if (open) {
      setPushResult(lastWebPushResult());
      setDesktopPermission(desktopNotificationPermission());
      setPushStatus(currentWebPushStatus());
    }
  }, [open]);
  const askDesktopPermission = async () => {
    setEnabling(true);
    try {
      // Always ask for the popup permission -- that is what makes the tab-open case
      // work, and it is a prerequisite for push anyway.
      setDesktopPermission(await requestDesktopNotificationPermission());
      // Then, when Firebase is configured, go the rest of the way: service worker,
      // FCM token, device row. Unconfigured deployments stop at the line above.
      if (currentWebPushStatus() !== 'not-configured') {
        setPushResult(await enableWebPush());
      }
      setPushStatus(currentWebPushStatus());
    } finally {
      setEnabling(false);
    }
  };
  const sound = (settings.data?.settings as {notification?: {sound?: boolean}} | undefined)?.notification?.sound ?? true;
  const toggleSound = async () => {
    if (!slug) return;
    unlockNotificationAudio();
    setSavingSound(true); setSoundError(false);
    try {
      await endpoints.notificationSettings(slug, {sound: !sound});
      await settings.refetch();
      if (!sound) playNotificationAudio();
    } catch { setSoundError(true); }
    finally { setSavingSound(false); }
  };

  const notifications = query.data?.notifications ?? [];
  const unread = notifications.filter((n) => n.read_at === null).length;

  // close on outside click / Escape (a11y, TASK-WEB-018)
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current !== null && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const markRead = async (ids?: string[]) => {
    if (slug === undefined) {
      return;
    }
    await endpoints.markNotificationsRead(slug, ids);
    void queryClient.invalidateQueries({ queryKey: ['notifications', slug] });
  };

  const openRow = async (row: InAppNotification) => {
    setOpen(false);
    if (row.read_at === null) {
      void markRead([row.id]);
    }
    if (row.type === 'ticket_due' && typeof row.data['ticket_id'] === 'string') {
      navigate(`/board/${row.data['ticket_id']}`);
      return;
    }
    if (row.room_id !== null) {
      const seq = typeof row.data['seq'] === 'number' ? row.data['seq'] : undefined;
      navigate(seq !== undefined ? `/rooms/${row.room_id}?around_seq=${seq}` : `/rooms/${row.room_id}`);
    }
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-lg px-2 py-1 text-lg hover:bg-slate-100"
        data-testid="notification-bell"
      >
        <Icon name="bell" size={19} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-yellow-400 px-1.5 text-[10px] font-bold text-slate-900">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notification center"
          className="absolute left-0 top-full z-30 mt-2 max-h-96 w-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg"
          data-testid="notification-panel"
        >
          <div className="flex items-center justify-between px-2 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notifications</span>
            {unread > 0 && (
              <button onClick={() => void markRead()} className="text-xs font-medium text-slate-500 hover:text-slate-800">
                Mark all read
              </button>
            )}
          </div>

          <label className="flex items-center gap-2 px-2 py-2 text-sm"><input type="checkbox" checked={sound} disabled={savingSound || !settings.data} onChange={() => void toggleSound()} />Notification sound</label>
          {/* Offered whenever this device is not actually receiving push, not only
              while permission is `default`. Permission granted + no FCM token is the
              silent-failure case, and hiding the button there left no way to retry. */}
          {desktopPermission !== 'denied' && desktopPermission !== 'unsupported' && pushResult?.state !== 'enabled' && (
            <button
              onClick={() => void askDesktopPermission()}
              disabled={enabling}
              data-testid="enable-desktop-notifications"
              className="mx-2 mb-2 rounded-lg bg-yellow-100 px-2 py-2 text-left text-sm font-medium text-slate-700 hover:bg-yellow-200"
            >
              {enabling
                ? 'Enabling…'
                : desktopPermission === 'granted'
                  ? 'Finish setting up notifications'
                  : 'Enable notifications'}
            </button>
          )}
          {/* Delivery state, deliberately separate from permission state: a granted
              permission with no registration token drops every push silently, and
              that used to be indistinguishable from notifications working. */}
          {pushResult?.state === 'failed' ? (
            <p className="px-2 pb-2 text-xs text-red-600" data-testid="push-status">
              Push could not be enabled: {pushResult.reason}
            </p>
          ) : (
            <p className="px-2 pb-2 text-xs text-slate-500" data-testid="push-status">
              {pushResult?.state === 'enabled'
                ? 'Push notifications are on for this device.'
                : desktopPermission === 'denied'
                  ? 'Notifications are blocked in your browser settings.'
                  : pushStatus === 'not-configured'
                    ? 'Push notifications are not set up on this server.'
                    : 'Push notifications are off for this device.'}
            </p>
          )}
          {/* The iOS install gate is a real capability boundary, not a failure:
              Safari exposes no Notification API in a normal tab, only once the
              site is on the Home Screen. Saying "unsupported" would be a dead end. */}
          {pushStatus === 'needs-install' && (
            <p className="px-2 pb-2 text-xs text-slate-500">
              To get notifications when the app is closed, add Banana Chat to your
              Home Screen: tap Share, then “Add to Home Screen”.
            </p>
          )}
          {soundError && <p role="alert" className="px-2 text-sm text-red-600">Could not save sound preference. Try again.</p>}
          {query.isLoading && <p className="px-2 py-3 text-sm text-slate-400">Loading…</p>}
          {!query.isLoading && notifications.length === 0 && (
            <p className="px-2 py-3 text-sm text-slate-400" data-testid="notification-empty">
              No notifications yet.
            </p>
          )}

          <ul>
            {notifications.map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => void openRow(row)}
                  className={`w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-yellow-50 ${
                    row.read_at === null ? 'bg-yellow-50/60' : ''
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden>{iconFor(row)}</span>
                    <span className="font-medium text-slate-700">{titleFor(row)}</span>
                    {row.read_at === null && (
                      <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-yellow-400" aria-label="unread" />
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-400">
                    {snippetFor(row)} · {new Date(row.created_at).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function iconFor(row: InAppNotification): string {
  if (row.type === 'ticket_due') return '◷';
  if (row.type === 'mention') return '@';
  if (row.type === 'added_to_room') return '#';
  return '🔑';
}

function titleFor(row: InAppNotification): string {
  if (row.type === 'ticket_due') return `Ticket #${row.data['number']} is due`;
  const actor = row.actor?.display_name ?? 'Someone';
  if (row.type === 'mention') return `${actor} mentioned you`;
  if (row.type === 'added_to_room') return `${actor} added you to a room`;
  return 'Session revoked';
}

function snippetFor(row: InAppNotification): string {
  if (row.type === 'ticket_due') return typeof row.data['title'] === 'string' ? row.data['title'] : '';
  if (row.type === 'mention') {
    const snippet = row.data['snippet'];
    return typeof snippet === 'string' ? snippet : '';
  }
  if (row.type === 'added_to_room') {
    const name = row.data['room_name'];
    return typeof name === 'string' ? name : '';
  }
  const reason = row.data['reason'];
  return `Reason: ${typeof reason === 'string' ? reason : 'unknown'}`;
}
