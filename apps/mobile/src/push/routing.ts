/**
 * TASK-MOB-008 — push routing decisions (pure logic, Jest-tested).
 */

/** TC-MOB-031 — foreground banner only when the push is NOT for the open room. */
export interface PushPayloadRoom {
  room_id?: string;
  workspace_slug?: string;
  conversation_id?: string;
  mention?: boolean;
}

export function shouldShowForegroundBanner(payload: PushPayloadRoom | null | undefined, currentRoomId: string | null): boolean {
  if (payload === null || payload === undefined) {
    return true;
  }
  if (payload.conversation_id !== undefined) {
    return true; // ai_completed — never suppress locally (focus reporting handles it)
  }
  if (payload.room_id === undefined) {
    return true;
  }
  return payload.room_id !== currentRoomId;
}

/** Android channel ids (TC-MOB-034) — registered at startup. */
export const ANDROID_CHANNELS = [
  { id: 'messages', name: 'ข้อความ', importance: 'high' as const },
  { id: 'mentions', name: '@mentions', importance: 'high' as const },
  { id: 'ai', name: 'AI Assistant', importance: 'default' as const },
];

export function androidChannelFor(payload: PushPayloadRoom | null | undefined): string {
  if (payload?.conversation_id !== undefined) {
    return 'ai';
  }
  if (payload?.mention === true) {
    return 'mentions';
  }
  return 'messages';
}

/** TC-MOB-033 — badge mirrors total unread whenever the app foregrounds. */
export function badgeNumber(totalUnread: number): number {
  return Math.max(0, Math.min(99_999, Math.floor(totalUnread)));
}

/** deep links: orgchat://room/{ws}/{roomId} and orgchat://ai/{conversationId} */
export function roomDeepLink(workspaceSlug: string, roomId: string): string {
  return `orgchat://room/${workspaceSlug}/${roomId}`;
}

export function parseDeepLink(url: string): { type: 'room'; workspaceSlug: string; roomId: string } | { type: 'ai'; conversationId: string } | null {
  const match = /^orgchat:\/\/(room|ai)\/([^/\s]+)(?:\/([^/\s]+))?$/.exec(url);
  if (match === null) {
    return null;
  }
  if (match[1] === 'ai') {
    return { type: 'ai', conversationId: match[2]! };
  }
  return match[3] === undefined ? null : { type: 'room', workspaceSlug: match[2]!, roomId: match[3]! };
}
