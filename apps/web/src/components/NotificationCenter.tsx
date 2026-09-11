import { useEffect, useRef, useState } from 'react';
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
  });

  const settings = useQuery({queryKey: ['notification-settings', me?.id], queryFn: () => endpoints.me(), enabled: me !== null});
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
  if (row.type === 'mention') return '@';
  if (row.type === 'added_to_room') return '#';
  return '🔑';
}

function titleFor(row: InAppNotification): string {
  const actor = row.actor?.display_name ?? 'Someone';
  if (row.type === 'mention') return `${actor} mentioned you`;
  if (row.type === 'added_to_room') return `${actor} added you to a room`;
  return 'Session revoked';
}

function snippetFor(row: InAppNotification): string {
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
