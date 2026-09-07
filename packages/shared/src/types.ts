/**
 * §8.8 wire types + §4.4 constants — the single source of truth shared by
 * api-client, chat-core, and the web app. Field names match the API payloads
 * exactly (snake_case).
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type RoomRole = 'owner' | 'admin' | 'member';
export type RoomType = 'dm' | 'group' | 'channel';
export type MessageType = 'text' | 'system' | 'image' | 'video' | 'file';
export type UserStatus = 'active' | 'suspended' | 'deactivated';

export interface UserStub {
  id: string;
  username: string;
  display_name: string;
  avatar_attachment_id: string | null;
}

export interface WorkspaceSummary {
  workspace: { id: string; slug: string; name: string; status: string };
  role: WorkspaceRole;
  unread_rooms_count: number;
  total_unread: number;
}

export interface Room {
  id: string;
  workspace_id: string;
  type: RoomType;
  name: string | null;
  description: string | null;
  avatar_attachment_id: string | null;
  created_by: string;
  last_seq: number;
  member_count: number;
  last_message_at: string | null;
}

export interface RoomListItem {
  room: Room;
  my_role: RoomRole;
  other_user: UserStub | null;
  /** latest message stub — §8.8 room list preview */
  last_message: { id: string; type: MessageType; body: string | null; sender_id: string; created_at: string } | null;
  unread_count: number;
  muted: boolean;
}

export interface SystemEvent {
  event: string;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  room_id: string;
  workspace_id: string;
  sender_id: string;
  sender: UserStub | null;
  type: MessageType;
  body: string | null;
  seq: number;
  client_message_id: string | null;
  reply_to: { id: string; sender_id: string; snippet: string | null; deleted: boolean } | null;
  system_event: SystemEvent | null;
  edited_at: string | null;
  edit_count: number;
  deleted_at: string | null;
  delete_reason: string | null;
  created_at: string;
  /** FR-MSG-008 — user ids mentioned by this message */
  mentions: string[];
  attachments: Attachment[];
}

export type AttachmentKind = 'image' | 'video' | 'file' | 'avatar';
export type AttachmentStatus = 'pending' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';

/** §8.8 attachment — urls are presigned GETs, valid until urls_expire_at */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  urls: {
    original: string | null;
    thumb_sm: string | null;
    thumb_md: string | null;
    poster: string | null;
  };
  urls_expire_at: string;
}

/** API-060 response */
export interface UploadTicket {
  attachment_id: string;
  put_url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface MessagePage {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
}

export interface ReadStatusEntry {
  user_id: string;
  username: string;
  display_name: string;
  avatar_attachment_id: string | null;
  last_read_seq: number;
  last_read_at: string | null;
}

/** §9 event envelope */
export interface EventEnvelope<T = unknown> {
  event: string;
  workspace_id: string;
  data: T;
  emitted_at: string;
}

export type RealtimeEventName =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'room.created'
  | 'room.updated'
  | 'room.deleted'
  | 'room.member_added'
  | 'room.member_removed'
  | 'room.member_role_changed'
  | 'room.read'
  | 'room.activity'
  | 'room.typing'
  | 'presence.updated'
  | 'attachment.ready'
  | 'attachment.failed'
  | 'user.updated'
  | 'workspace.unread_changed'
  | 'workspace.member_added'
  | 'session.revoked';

/** §4.4 defaults — mirrored from SettingsService::DEFAULTS */
export const DEFAULT_SETTINGS = {
  'message.max_length': 4000,
  'message.edit_window_minutes': 1440,
  'message.max_attachments': 10,
  'room.group.max_members': 500,
  'room.deleted_purge_days': 30,
  'auth.password.min_length': 10,
  'auth.lockout.threshold': 10,
  'auth.lockout.minutes': 15,
  'auth.access_token_ttl_minutes': 60,
  'auth.refresh_token_ttl_days': 30,
  'auth.max_sessions_per_user': 10,
  'presence.offline_after_seconds': 60,
  'typing.ttl_seconds': 5,
} as const;

/** §7 error codes that the client reasons about */
export const ERROR_CODES = {
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_REFRESH_REUSED: 401,
  ACCOUNT_SUSPENDED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  WS_HEADER_REQUIRED: 400,
  WS_FORBIDDEN: 403,
  WS_ARCHIVED: 403,
  ROOM_NOT_MEMBER: 403,
  ROOM_FORBIDDEN: 403,
  ROOM_DM_IMMUTABLE: 422,
  ROOM_FULL: 422,
  MSG_TOO_LONG: 422,
  MSG_EMPTY: 422,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
