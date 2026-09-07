import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import Constants from 'expo-constants';
import type { EventEnvelope, AiStreamEvent } from '@banana-chat/shared';
import { API_BASE_URL, tokenManager } from '../lib/api';
import { handleAiEvent } from '../ai/store';
import { useSession } from '../auth/session';

/**
 * TASK-MOB-002/015 — realtime: one Echo instance per session over Reverb,
 * authorizing private channels with the in-memory access token. User-channel
 * events drive the AI store (EVT-050..056) and admin session revocation.
 */

interface ReverbConfig {
  key: string;
  host: string;
  port: number;
}

function reverbConfig(): ReverbConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  return {
    key: typeof extra.reverbAppKey === 'string' ? extra.reverbAppKey : 'banana-chat-reverb',
    host: typeof extra.reverbHost === 'string' ? extra.reverbHost : '127.0.0.1',
    port: typeof extra.reverbPort === 'number' ? extra.reverbPort : 8088,
  };
}

let echo: Echo<'reverb'> | null = null;

const AI_EVENTS = [
  'ai.message.started',
  'ai.message.delta',
  'ai.message.completed',
  'ai.message.failed',
  'ai.conversation.updated',
  'ai.conversation.compacted',
  'ai.conversation.deleted',
] as const;

/** connect after login/bootstrap; subscribes user + current workspace channels */
export function connectRealtime(onRoomsChanged: () => void): void {
  disconnectRealtime();
  const { me, currentWorkspace } = useSession.getState();
  if (me === null) {
    return;
  }
  const cfg = reverbConfig();
  (globalThis as { Pusher?: typeof Pusher }).Pusher = Pusher;
  echo = new Echo<'reverb'>({
    broadcaster: 'reverb',
    key: cfg.key,
    wsHost: cfg.host,
    wsPort: cfg.port,
    wssPort: cfg.port,
    forceTLS: false,
    enabledTransports: ['ws', 'wss'],
    authorizer: (channel: { name: string }) => ({
      authorize: (socketId: string, callback: (error: unknown, response: unknown) => void) => {
        const token = tokenManager.getAccessToken();
        void fetch(`${API_BASE_URL}/api/v1/broadcasting/auth`, {
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

  const user = echo.private(`user.${me.id}`);
  user.listen('.session.revoked', (envelope: EventEnvelope<{ reason: string }>) => {
    if (envelope.data?.reason !== 'logout') {
      // another device's logout must not kill this one (FR-AUTH-011)
      void useSession.getState().logout();
    }
  });
  for (const name of AI_EVENTS) {
    user.listen(`.${name}`, (envelope: EventEnvelope<Record<string, unknown>>) => {
      handleAiEvent({ event: name, ...(envelope.data ?? {}) } as AiStreamEvent);
    });
  }

  if (currentWorkspace !== null) {
    const ws = echo.private(`workspace.${currentWorkspace.workspace.id}`);
    for (const name of ['room.created', 'room.updated', 'room.deleted', 'room.member_added', 'room.member_removed', 'workspace.unread_changed']) {
      ws.listen(`.${name}`, onRoomsChanged);
    }
  }
}

export function disconnectRealtime(): void {
  echo?.disconnect();
  echo = null;
}

export function realtimeConnected(): boolean {
  return echo?.connector?.pusher?.connection?.state === 'connected';
}
