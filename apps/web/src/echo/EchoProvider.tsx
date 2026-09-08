import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventEnvelope } from '@banana-chat/shared';
import { endpoints, tokenManager } from '../lib/api';
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

  // user-scoped channel: session.revoked (admin suspend/logout-all), user.updated
  useEffect(() => {
    if (instance === null || me === null) {
      return;
    }
    const channel = instance.private(`user.${me.id}`);

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
    return () => {
      channel.stopListening('.session.revoked');
      for (const name of aiEvents) {
        channel.stopListening(`.${name}`);
      }
    };
  }, [instance, me, logout]);

  // workspace channel: room list churn + unread badges
  useEffect(() => {
    if (instance === null || currentWorkspace === null) {
      return;
    }
    const slug = currentWorkspace.workspace.slug;
    const channel = instance.private(`workspace.${currentWorkspace.workspace.id}`);
    const refreshRooms = () => {
      void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    };

    channel.listen('.room.created', refreshRooms);
    channel.listen('.room.updated', refreshRooms);
    channel.listen('.room.deleted', refreshRooms);
    channel.listen('.room.member_added', refreshRooms);
    channel.listen('.room.member_removed', refreshRooms);
    channel.listen('.workspace.unread_changed', refreshRooms);
    return () => {
      channel.stopListening('.room.created');
      channel.stopListening('.room.updated');
      channel.stopListening('.room.deleted');
      channel.stopListening('.room.member_added');
      channel.stopListening('.room.member_removed');
      channel.stopListening('.workspace.unread_changed');
    };
  }, [instance, currentWorkspace, queryClient]);

  const value = useMemo(() => ({ echo: instance, connected }), [instance, connected]);
  return <EchoContext.Provider value={value}>{children}</EchoContext.Provider>;
}
