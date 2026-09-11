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
  reply_to: { seq?: number; id: string; sender_id: string; snippet: string | null; deleted: boolean } | null;
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
  put_url: string | null;
  multipart?: { upload_id: string; part_size: number; part_urls: string[] } | null;
  headers: Record<string, string>;
  expires_at: string;
}

export interface MessagePage {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
}

// ---- §5.10 SRCH — search (API-080/081) ----

export interface RoomBrief {
  id: string;
  workspace_id: string;
  type: RoomType;
  name: string | null;
}

export interface MessageSearchResult {
  message: Message;
  room: RoomBrief | null;
  /** HTML — the only raw markup is <mark> tags; body is pre-escaped server-side (TC-SRCH-005) */
  highlight: string;
}

export interface FileSearchResult {
  attachment: {
    id: string;
    message_id: string;
    kind: AttachmentKind;
    original_name: string;
    mime_type: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
    created_at: string;
  };
  message: {
    id: string;
    room_id: string;
    sender_id: string;
    seq: number;
    body: string | null;
    created_at: string;
  };
  room: RoomBrief | null;
}

export interface SearchPage<T> {
  results: T[];
  next_cursor: string | null;
}

// ---- §5.9 FR-NOTI-006 — in-app notification center (API-073) ----

export type InAppNotificationType = 'mention' | 'added_to_room' | 'session_revoked' | 'ticket_due';

export interface InAppNotification {
  id: string;
  type: InAppNotificationType;
  workspace_id: string | null;
  room_id: string | null;
  actor: { id: string; username: string; display_name: string } | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
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

// ---- §5.14 / §8.9 AI Assistant wire types ----

export type AiMessageRole = 'user' | 'assistant';
export type AiMessageStatus = 'pending' | 'streaming' | 'completed' | 'cancelled' | 'failed';
export type AiMemoryCategory = 'profile' | 'preference' | 'project' | 'other';

/** API-100 */
export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  allowed_in_workspace: boolean;
  provider: { name: string; model: string; window_size: number } | null;
  limits: { daily_messages: number; max_message_chars: number };
  usage_today: { date: string; messages: number; tokens_in: number; tokens_out: number; failed: number };
  memory_enabled: boolean;
  consented: boolean;
}

/** §8.9 ai_conversation_summary */
export interface AiConversationSummary {
  id: string;
  title: string | null;
  title_source: 'user' | 'auto' | null;
  message_count: number;
  last_message_at: string | null;
  archived_at: string | null;
  generating: boolean;
}

/** §8.9 ai_message — partial_content/last_index present while live (API-117) */
export interface AiMessage {
  id: string;
  conversation_id: string;
  seq: number;
  role: AiMessageRole;
  status: AiMessageStatus;
  content: string | null;
  client_message_id: string | null;
  parent_message_id: string | null;
  model: string | null;
  finish_reason: string | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  error_code: string | null;
  /** DEC-042 — set when regenerate/edit-resend retired this row (FR-AI-009 "1/2" toggle) */
  superseded_at?: string | null;
  created_at: string | null;
  completed_at: string | null;
  partial_content?: string | null;
  last_index?: number | null;
}

/** API-106 page — array + pagination nested inside data (client unwraps the outer envelope) */
export interface AiMessagePage {
  messages: AiMessage[];
  has_more_before: boolean;
  oldest_seq: number | null;
  summary_up_to_seq: number;
}

/** API-106 send response (202, or 200 on client_message_id replay) */
export interface AiSendResponse {
  user_message: AiMessage;
  assistant_message: AiMessage | null;
}

/** API-114 regenerate response */
export interface AiRegenerateResponse {
  assistant_message: AiMessage;
}

/** FR-AI-015 share response — the created room message */
export interface AiShareResponse {
  message: Message;
}

/** API-116 search row — hit + the conversation it belongs to */
export interface AiSearchResult {
  message: AiMessage;
  conversation: { id: string; title: string | null; archived_at: string | null } | null;
}

export interface AiMemory {
  id: string;
  content: string;
  category: AiMemoryCategory;
  importance: number;
  source: 'user' | 'assistant';
  source_conversation_id?: string | null;
  last_used_at?: string | null;
  created_at?: string | null;
}

/** EVT-050..056 payloads arriving on private-user.{uid} */
export type AiStreamEvent =
  | { event: 'ai.message.started'; conversation_id: string; message_id: string }
  | { event: 'ai.message.delta'; conversation_id: string; message_id: string; index: number; delta: string }
  | { event: 'ai.message.completed'; message: AiMessage }
  | { event: 'ai.message.failed'; conversation_id: string; message_id: string; error_code: string }
  | { event: 'ai.conversation.updated'; conversation_summary: AiConversationSummary }
  | { event: 'ai.conversation.compacted'; conversation_id: string }
  | { event: 'ai.conversation.deleted'; conversation_id: string };

/** FR-NOTE-001 — a durable room note, independent from message history. */
export interface RoomNote { id: string; room_id: string; author_id: string; author_name: string; body: string | null; attachments: Attachment[]; created_at: string; updated_at: string; }

// FR-KAN-001..005 / API-140..148
export interface KanbanLane { id: string; workspace_id: string; name: string; color: string; position: number; is_done: boolean }
export type TicketType = 'task' | 'bug' | 'story';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type TicketPerson = Pick<UserStub, 'id' | 'username' | 'display_name'>;
export interface KanbanTicket {
  id: string; workspace_id: string; number: number; title: string; description: string | null;
  lane_id: string; type: TicketType; priority: TicketPriority; assignee_id: string | null; reporter_id: string | null;
  assignee: TicketPerson | null; reporter: TicketPerson | null; labels: string[]; due_at: string | null;
  version: number; created_at: string; updated_at: string;
}
export interface TicketComment { id: string; body: string; author: TicketPerson | null; created_at: string }
export interface TicketHistory { id: string; actor: TicketPerson | null; changes: Record<string,{from:unknown;to:unknown}>; created_at: string }
export interface TicketDetail extends KanbanTicket { comments: TicketComment[]; comments_cursor: string | null; history: TicketHistory[] }
export interface TicketInput { title: string; description?: string | null; lane_id: string; type?: TicketType; priority?: TicketPriority; assignee_id?: string | null; due_at?: string | null; labels?: string[] }

/** FR-CALL-001..004 / API-150..155 */
export interface RoomCall {
  id: string; room_id: string; workspace_id: string; kind: 'voice' | 'video';
  started_by: string; caller_name: string; room_name: string | null; room_type: 'dm' | 'group';
  participants: string[]; created_at: string; connected_at: string | null; ended_at: string | null;
}
export interface CallJoin { call: RoomCall; token: string; url: string }

/** FR-MEET-001..005 — public video meeting capabilities. */
export interface PublicMeeting {
  id: string; code: string; title: string; expires_at: string; ended_at: string | null; created_at: string;
}
export interface MeetingLobby {
  title: string; expires_at: string; capacity: number; identity: {name: string; member: true} | null;
}
export interface MeetingJoin {
  meeting: PublicMeeting; participant_id: string; participant_token: string;
  url: string; token: string; can_end: boolean; workspace_slug: string | null;
}
