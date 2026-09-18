import { NotificationGate } from '@banana-chat/chat-core';
import { showDesktopNotification } from '../lib/desktop-notification';
import { registerPushServiceWorker, reportFocus } from '../lib/web-push';
import { playNotificationAudio } from '../lib/notification-audio';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import type { EventEnvelope, RoomListItem } from '@banana-chat/shared';
import { endpoints, tokenManager } from '../lib/api';
import { evictRoom } from '../lib/room-eviction';
import { useSession } from '../state/session';
import { handleAiEvent } from '../state/ai';
import type { AiStreamEvent } from '@banana-chat/shared';

declare global {
  interface Window {
    Pusher: typeof Pusher;
  }
}

interface EchoContextValue {
  echo: Echo<'reverb'> | null;
  connected: boolean;
}

const EchoContext = createContext<EchoContextValue>({ echo: null, connected: false });

export function useEcho(): EchoContextValue {
  return useContext(EchoContext);
}

/**
 * TASK-WEB-003 — one Echo instance per session. Authorizes private channels
 * through the API's /broadcasting/auth with the in-memory access token.
 */
export function EchoProvider({ children }: { children: ReactNode }) {
  const { status, me, currentWorkspace, logout } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [connected, setConnected] = useState(false);
  const echoRef = useRef<Echo<'reverb'> | null>(null);
  const [instance, setInstance] = useState<Echo<'reverb'> | null>(null);

  // (re)create Echo when the session becomes authenticated
  useEffect(() => {
    if (status !== 'authenticated') {
      echoRef.current?.leaveAllChannels?.();
      echoRef.current = null;
      setInstance(null);
      setConnected(false);
      return;
    }

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
          const token = tokenManager.getAccessToken();
          void fetch('/api/v1/broadcasting/auth', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ socket_id: socketId, channel_name: channel.name }),
          })
            .then(async (response) => callback(false, await response.json()))
            .catch((error: unknown) => callback(true as never, error as never));
        },
      }),
    });

    echoRef.current = echo;
    setInstance(echo);

    const connection = echo.connector.pusher.connection;
    const updateState = (states: { current: string }) => setConnected(states.current === 'connected');
    connection.bind('state_change', updateState);
    setConnected(connection.state === 'connected');

    return () => {
      connection.unbind('state_change', updateState);
      echo.disconnect();
    };
  }, [status]);

  // FR-NOTI-003 — register the push service worker once per load. Idempotent, and a
  // no-op when Firebase is unconfigured, which is the default deployment.
  //
  // NOTE: deliberately NO firebase onMessage handler. FCM hands a push to the PAGE
  // when a window client is visible and to the SERVICE WORKER otherwise. The tab-open
  // case is already covered by the EVT-063 websocket alert below, so adding onMessage
  // would render a second popup for the same message -- and the two paths carry
  // different ids, so the dedupe gate could not catch it. Websocket owns foreground,
  // the worker owns background.
  useEffect(() => {
    void registerPushServiceWorker();
  }, []);

  // API-074 focus ping. The server silences a push for a room this device is already
  // reading within the last 30s (FR-NOTI-002); web never reported anything, so a
  // desktop user got a phone push for the message they were looking at.
  useEffect(() => {
    if (me === null) {
      return;
    }
    const roomId = /^\/rooms\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
    const report = () => reportFocus(document.visibilityState === 'visible' ? roomId : null);
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [location.pathname, me]);

  // user-scoped channel: session.revoked (admin suspend/logout-all), user.updated
  useEffect(() => {
    if (instance === null || me === null) {
      return;
    }
    const channel = instance.private(`user.${me.id}`);
    const notifications = new NotificationGate();
    channel.listen('.notification.alert', (envelope: EventEnvelope<{id: string; room_id: string | null; kind: string}>) => {
      void queryClient.invalidateQueries({queryKey: ['notifications']});
      const data = envelope.data;
      if (!data?.id) return;
      // `focused` gates the chime: only a message in the room you are actually
      // looking at is "already seen". For the OS popup we want the same rule but
      // for every kind -- a call or a mention arriving while you stare at that
      // room does not need a popup either.
      const lookingAtRoom = data.room_id !== null && data.room_id === openRoomId()
        && document.visibilityState === 'visible' && document.hasFocus();
      const focused = data.kind === 'message' && lookingAtRoom;
      if (notifications.accept(data.id, true, focused, Date.now())) playNotificationAudio();

      // FR-NOTI-003 foreground branch. Rendered here rather than in a second
      // channel.listen('.notification.alert', ...) on purpose: laravel-echo's
      // stopListening(event) with no callback unbinds EVERY listener for that
      // event, so a second registration is a cleanup hazard (see the note at the
      // room-channel teardown below).
      if (!lookingAtRoom) {
        // ['rooms', slug, filter] -- the slug and filter are not in scope here, and
        // endpoints.rooms() resolves to RoomListItem[] directly, so scan every
        // cached rooms query for the id instead of reconstructing the key.
        const room = queryClient
          .getQueriesData<RoomListItem[]>({ queryKey: ['rooms'] })
          .flatMap(([, list]) => list ?? [])
          .find((r) => r.room.id === data.room_id);
        showDesktopNotification(
          {
            id: data.id,
            kind: data.kind,
            roomName: room?.room.name ?? room?.other_user?.display_name ?? null,
            href: data.room_id !== null ? `/rooms/${data.room_id}` : '/',
          },
          navigate,
        );
      }
    });
    const openRoomId = () => /^\/rooms\/([^/]+)/.exec(window.location.pathname)?.[1];

    // room list refetch gives authoritative order/unread/preview; bursts of
    // room.activity coalesce into one refetch per 2s window (leading + trailing)
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    const refreshRooms = () => {
      lastRun = Date.now();
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    };
    const throttledRoomRefresh = () => {
      if (timer !== null) {
        return;
      }
      const wait = 2_000 - (Date.now() - lastRun);
      if (wait <= 0) {
        refreshRooms();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        refreshRooms();
      }, wait);
    };

    channel.listen('.session.revoked', (envelope: EventEnvelope<{ session_id: string; reason: string }>) => {
      if (envelope.data?.reason === 'logout') {
        // another device's logout must not kill this one
        return;
      }
      // EVT-025/TC-AUTH-008 — the event targets ONE session (e.g. LRU cap
      // eviction). This page may be a different, still-alive session of the
      // same user: verify with the API before killing the session locally.
      void endpoints
        .me()
        .then(() => undefined)
        .catch(() => {
          window.alert('Your session was revoked. Please sign in again.');
          void logout();
        });
    });

    // EVT-050..056 — AI assistant events (stream deltas, conversation churn)
    const aiEvents = [
      'ai.message.started',
      'ai.message.delta',
      'ai.message.completed',
      'ai.message.failed',
      'ai.conversation.updated',
      'ai.conversation.compacted',
      'ai.conversation.deleted',
    ];
    for (const name of aiEvents) {
      channel.listen(`.${name}`, (envelope: EventEnvelope<Record<string, unknown>>) => {
        handleAiEvent({ event: name, ...(envelope.data ?? {}) } as AiStreamEvent);
      });
    }

    // EVT-001 room.created — new rooms/DMs land here on private-user, NOT on
    // the workspace channel (found on prod: a fresh DM never appeared in the
    // recipient's sidebar until reload).
    channel.listen('.room.created', () => {
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    });

    // EVT-003 room.deleted — owner deletion and secret-room expiry (FR-ROOM-
    // 012) both fan out here: drop the room from every list and purge its
    // local content. The scope comes from envelope.workspace_id, NOT the
    // currently-open workspace — the user channel is account-wide, so the
    // event may describe a room of a workspace the user has since switched
    // away from (its cache lives under that workspace's scope).
    channel.listen('.room.deleted', (envelope: EventEnvelope<{ room_id: string }>) => {
      const roomId = envelope.data?.room_id;
      const workspaceId = envelope.workspace_id;
      if (roomId === undefined || workspaceId === '') {
        return;
      }
      void evictRoom({ userId: me.id, workspaceId }, roomId);
    });

    // EVT-015 room.activity — message in a room we are not subscribed to
    // (only the open room has a private-room channel — DEC-009). This is the
    // only realtime source of preview + unread badge for background rooms
    // (found on prod: badges and previews never updated for unfocused rooms).
    channel.listen('.room.activity', (envelope: EventEnvelope<{ room_id: string }>) => {
      // skip the refetch when the activity is for the room this client is
      // reading — the room channel already handled it (markRead clears the
      // badge, so a refetch here would only race it).
      if (envelope.data?.room_id !== undefined && envelope.data.room_id === openRoomId()) {
        return;
      }
      throttledRoomRefresh();
    });

    // EVT-024 workspace.unread_changed — cross-device badge sync (FR-READ-001/003).
    // Shares the throttle: the server fans this out alongside room.activity
    // for every message, so it bursts the same way.
    channel.listen('.workspace.unread_changed', throttledRoomRefresh);
    const refreshMemberships = () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    };
    channel.listen('.workspace.member_added', refreshMemberships);
    channel.listen('.workspace.member_removed', refreshMemberships);

    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      channel.stopListening('.notification.alert');
      channel.stopListening('.session.revoked');
      for (const name of aiEvents) {
        channel.stopListening(`.${name}`);
      }
      channel.stopListening('.room.created');
      channel.stopListening('.room.deleted');
      channel.stopListening('.room.activity');
      channel.stopListening('.workspace.unread_changed');
      channel.stopListening('.workspace.member_added');
      channel.stopListening('.workspace.member_removed');
    };
  }, [instance, me, logout, queryClient]);

  // workspace channel (FR-RT-001): user.updated / user.status_changed —
  // directory + roster freshness (deactivated members must disappear).
  useEffect(() => {
    if (instance === null || currentWorkspace === null) {
      return;
    }
    const channel = instance.private(`workspace.${currentWorkspace.workspace.id}`);
    const refreshPeople = () => {
      void queryClient.invalidateQueries({ queryKey: ['directory'] });
      void queryClient.invalidateQueries({ queryKey: ['room-members'] });
    };

    channel.listen('.user.updated', refreshPeople);
    channel.listen('.user.status_changed', refreshPeople);

    // EVT-081/082 (FR-PCHAT-003/004) — public chat room created / changed. The
    // staff variants fan out to private-workspace.{wid} so every agent's queue
    // and rail badge move without anyone having the conversation open.
    //
    // THESE LIVE HERE AND ONLY HERE. laravel-echo's stopListening(event) with no
    // callback unbinds EVERY listener for that event on the channel, so a second
    // component subscribing to the same workspace channel would silently kill
    // this one's handler the moment it unmounted.
    const refreshPublicChat = () => {
      // deliberately NOT the whole ['public-chat'] prefix: that includes
      // ['public-chat','messages',slug,roomId], so any room's status change
      // would refetch the transcript an agent has open and reset its
      // "load earlier" state. The open room gets its own staff-channel events.
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'summary'] });
      void queryClient.invalidateQueries({ queryKey: ['public-chat', 'room'] });
    };
    channel.listen('.public_chat.room.created', refreshPublicChat);
    channel.listen('.public_chat.room.changed', refreshPublicChat);

    return () => {
      channel.stopListening('.user.updated');
      channel.stopListening('.user.status_changed');
      channel.stopListening('.public_chat.room.created');
      channel.stopListening('.public_chat.room.changed');
    };
  }, [instance, currentWorkspace, queryClient]);

  const value = useMemo(() => ({ echo: instance, connected }), [instance, connected]);
  return <EchoContext.Provider value={value}>{children}</EchoContext.Provider>;
}
