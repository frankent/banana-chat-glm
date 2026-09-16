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
  /**
   * FR-ROOM-012 — secret room (creator-chosen expiry, DEC-056). Optional
   * because rows cached before the field shipped (and old fixtures) lack it;
   * treat undefined as an ordinary room.
   */
  is_secret?: boolean;
  secret_expires_at?: string | null;
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
  /**
   * FR-PCHAT-033/034, DEC-071 — public chat ships DISABLED. Enabling is a
   * deliberate admin act; `link_ttl_days` and `max_message_length` are numeric,
   * so each also has a `Settings::ranges()` row server-side (1..365 / 1..32000).
   */
  'publicchat.enabled': false,
  'publicchat.link_ttl_days': 30,
  'publicchat.max_message_length': 4000,
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
  ROOM_EXPIRED: 410,
  MSG_TOO_LONG: 422,
  MSG_EMPTY: 422,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  // §7.1 FR-PCHAT. Visitor/agent tiers:
  PCHAT_DISABLED: 503,
  PCHAT_ROOM_NOT_FOUND: 404,
  PCHAT_ROOM_CLOSED: 409,
  PCHAT_LINK_EXPIRED: 410,
  PCHAT_INVALID_TRANSITION: 422,
  /** FR-PCHAT-013 — a signed-in member may READ the link but never write as the visitor. */
  PCHAT_SIGNED_IN: 403,
  // Partner HMAC tier (FR-PCHAT-031). Never surfaced to a browser: no client
  // signs a partner request, so these exist for completeness and error mapping.
  API_KEY_INVALID: 401,
  API_SIGNATURE_INVALID: 401,
  API_TIMESTAMP_SKEW: 401,
  API_NONCE_REPLAYED: 409,
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
  attachments: Attachment[];
  id: string; workspace_id: string; number: number; title: string; description: string | null;
  lane_id: string; type: TicketType; priority: TicketPriority; assignee_id: string | null; reporter_id: string | null;
  assignee: TicketPerson | null; reporter: TicketPerson | null; labels: string[]; due_at: string | null;
  version: number; created_at: string; updated_at: string;
}
export interface TicketComment { id: string; body: string; author: TicketPerson | null; created_at: string }
export interface TicketHistory { id: string; actor: TicketPerson | null; changes: Record<string,{from:unknown;to:unknown}>; created_at: string }
export interface TicketDetail extends KanbanTicket { comments: TicketComment[]; comments_cursor: string | null; history: TicketHistory[] }
export interface TicketInput { attachment_ids?: string[]; title: string; description?: string | null; lane_id: string; type?: TicketType; priority?: TicketPriority; assignee_id?: string | null; due_at?: string | null; labels?: string[] }

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

// ---- §5.18 FR-PCHAT — public support chat (§8.10 API-200..228, §9 EVT-080..085) ----
//
// DEC-064: public chat is an isolated bounded context. A support conversation is
// NEVER a `rooms` row and a support message is NEVER a `messages` row, so none of
// the types below extend `Room`/`Message` and `RoomType` above is untouched —
// this feature adds no room type.
//
// DEC-065: there are TWO serializers and two channels. Everything named
// `PublicChat*Public*`/`PublicChatVisitor*` is what a customer holding the
// capability link may see; everything named `PublicChat*Staff*` is internal.
// They are deliberately separate declarations with no shared base: a shared base
// is precisely how a field added for staff leaks to the customer.

/** Internal queue status. NEVER sent to a visitor surface (FR-PCHAT-007). */
export type PublicChatStatus = 'new' | 'in_progress' | 'done' | 'problem';

/**
 * The only status projection a visitor ever receives (MANDATORY graft 1 /
 * FR-PCHAT-007): new|in_progress|problem → 'open', done → 'closed'. A customer
 * must not learn that support flagged their conversation `problem`.
 */
export type PublicChatStatusPublic = 'open' | 'closed';

/** Set server-side from the authenticated tier — never read from a payload. */
export type PublicChatSenderKind = 'visitor' | 'agent' | 'system';

/** No call/meet/AI type exists in this context (FR-PCHAT-002/006). */
export type PublicChatMessageType = 'text' | 'image' | 'video' | 'file' | 'system';

/** System rows carry `body: null` + this, so each reader gets their own locale. */
export type PublicChatSystemEvent =
  | 'claimed'
  | 'reassigned'
  | 'status_changed'
  | 'closed_by_customer'
  | 'link_rotated';

/** Why API-210 reports the composer shut: the ticket is done, or the kill switch is on. */
export type PublicChatClosedReason = 'done' | 'disabled';

/** `public_chat_rooms.locale`, default 'th' (FR-I18N-001). Mirrors shared `Locale`. */
export type PublicChatLocale = 'th' | 'en';

/** {id,username,display_name} — staff surfaces only; never on a visitor payload. */
export type PublicChatAgentStub = Pick<UserStub, 'id' | 'username' | 'display_name'>;

// -- Tier 2 wire shapes: the customer surface (API-210..216, private-public-chat.{rid}) --

/**
 * API-210 `room` — EXACTLY what `PublicChatPublicSerializer::room()` emits.
 *
 * `id` is present and load-bearing: the visitor page cannot derive the room
 * ULID from its 64-hex code, and it needs the ULID to subscribe to
 * `private-public-chat.{id}` — which API-215 validates by literal string
 * equality (design "Realtime", MANDATORY fix 12). The `code` is NOT echoed
 * back; the visitor already holds it in their own URL.
 *
 * Note what is ABSENT and must stay absent (FR-PCHAT-014): no workspace_id, no
 * RAW `status` (only the `open|closed` projection), no assignee, no `meta`, no
 * `external_ref`.
 */
export interface PublicChatVisitorRoom {
  id: string;
  customer_name: string;
  provider_name: string;
  status_public: PublicChatStatusPublic;
  locale: PublicChatLocale;
  created_at: string | null;
  expires_at: string | null;
  last_seq: number;
}

/** FR-PCHAT-013 — a signed-in member who opened the customer link. */
export interface PublicChatViewer {
  kind: 'member';
  display_name: string;
}

/** API-210 response. `can_send` is authoritative; the client derives the reason. */
export interface PublicChatVisitorView {
  room: PublicChatVisitorRoom;
  can_send: boolean;
  feature_enabled: boolean;
  closed_reason: PublicChatClosedReason | null;
  /** null for a genuine visitor; FR-PCHAT-013 populates it for a member bearer. */
  viewer: PublicChatViewer | null;
}

/**
 * Inline reply/quote on the CUSTOMER surface (MANDATORY graft 4). Snippet only:
 * no sender id, no sender kind, no display name. `snippet` is null when the
 * quoted row has been deleted — that null IS the tombstone, so there is no
 * separate `deleted` flag.
 */
export interface PublicChatPublicReplySnippet {
  id: string;
  seq: number;
  snippet: string | null;
}

/**
 * Inline reply/quote on the AGENT surface. Carries `sender_kind` — enough to
 * render "replying to the customer" vs "replying to a colleague" — which the
 * public variant deliberately omits.
 */
export interface PublicChatStaffReplySnippet {
  id: string;
  seq: number;
  sender_kind: PublicChatSenderKind;
  snippet: string | null;
}

/**
 * The visitor-facing message (API-211/212, EVT-080 public variant). Structurally
 * different from `PublicChatStaffMessage`, not a subset of it: no
 * `sender_user_id`, no `sender`, no snapshots, no `client_message_id`, no
 * `mentions`, no `workspace_id`, no `deleted_by`, no `system_meta.actor_username`.
 */
export interface PublicChatPublicMessage {
  id: string;
  seq: number;
  sender_kind: PublicChatSenderKind;
  /**
   * The external display name, ASSEMBLED SERVER-SIDE from the write-time
   * snapshots and rendered as a plain text node (MANDATORY fix 20): the agent's
   * `provider name (admin username)` (chat-core `agentExternalName`), the
   * customer's own name for a visitor row, and null for a system row. The
   * public serializer never joins `users`, so a later rename does not rewrite
   * an existing transcript (FR-PCHAT-014).
   */
  display_name: string | null;
  type: PublicChatMessageType;
  body: string | null;
  reply_to: PublicChatPublicReplySnippet | null;
  system_event: PublicChatSystemEvent | null;
  /** Projected: statuses are `status_public`, and there is NO `actor_username`. */
  system_meta: { from?: PublicChatStatusPublic; to?: PublicChatStatusPublic } | null;
  attachments: Attachment[];
  /**
   * `PublicChatMessage` has NO SoftDeletes trait, so a deleted row STAYS in the
   * transcript (removing it would renumber the customer's visible `seq`) and
   * the server renders the tombstone: `deleted: true` with `body`, `reply_to`,
   * `display_name` and `system_meta` all nulled and `attachments` emptied.
   * The public payload carries the FLAG only — never `deleted_at`/`deleted_by`.
   */
  deleted: boolean;
  created_at: string | null;
}

/** API-211 — reconnect catch-up / 5 s polling fallback (`?after_seq=`). */
export interface PublicChatVisitorMessagePage {
  messages: PublicChatPublicMessage[];
  last_seq: number;
}

/**
 * API-213 / API-225 upload ticket. DELIBERATELY NOT the shared `UploadTicket`
 * (API-060): this context answers `{attachment:{id,status}, upload_url,
 * multipart?}` and omits API-060's `headers` / `expires_at`. Keys absent from
 * the response are absent here too — `upload_url` and `multipart` are each
 * dropped entirely when null (the controllers `array_filter` them out), which
 * is why both are optional rather than nullable-and-required.
 *
 * See the reconciliation note in the FR-PCHAT report: this divergence from the
 * product-wide API-060 convention is REPORTED, not silently blessed.
 */
export interface PublicChatUploadTicket {
  attachment: { id: string; status: AttachmentStatus };
  upload_url?: string;
  multipart?: { upload_id: string; part_size: number; part_urls: string[] };
}

/** API-214 — completion answers the id/status pair only, never a full `Attachment`. */
export interface PublicChatUploadCompletion {
  attachment: { id: string; status: AttachmentStatus };
}

// -- Tier 3 wire shapes: the agent surface (API-220..228, private-public-chat-staff.{rid}) --

/**
 * RAW, staff-only system metadata — internal identity, staff channel only.
 * Two shapes by event: `status_changed` / `closed_by_customer` carry the two
 * RAW statuses (`problem` included) in `{from,to}`; `claimed` / `reassigned`
 * carry member ULIDs in `{from_user_id,to_user_id}`. Either may carry
 * `actor_username`. The public serializer projects this down to
 * `{from?,to?}` in `status_public` terms and drops `actor_username` entirely.
 */
export interface PublicChatStaffSystemMeta {
  from?: string;
  to?: string;
  from_user_id?: string;
  to_user_id?: string;
  actor_username?: string;
}

/** API-222/223, EVT-080 staff variant — what `PublicChatStaffSerializer::message()` emits. */
export interface PublicChatStaffMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_kind: PublicChatSenderKind;
  /** The real member behind an agent row; null on visitor and system rows. */
  sender: PublicChatAgentStub | null;
  /**
   * The exact string the CUSTOMER sees for this row — `provider (username)`
   * from the write-time snapshots. Present on the staff surface on purpose, so
   * an agent can tell at a glance how their message was signed externally.
   */
  external_display_name: string | null;
  /** The room's `customer_name`, so a visitor row renders without a join. */
  visitor_display_name: string | null;
  type: PublicChatMessageType;
  body: string | null;
  reply_to: PublicChatStaffReplySnippet | null;
  system_event: PublicChatSystemEvent | null;
  system_meta: PublicChatStaffSystemMeta | null;
  /** NOT NULL (DEC-066); unique with (room_id, sender_kind). System rows get a ULID. */
  client_message_id: string;
  attachments: Attachment[];
  /** The tombstone flag; staff additionally get the audit pair below. */
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string | null;
}

/**
 * API-222 page. NOT the internal `MessagePage`'s `has_more_*` shape: this
 * endpoint answers ascending rows plus the room's `last_seq`, which is what the
 * agent view needs to decide whether it is caught up.
 */
export interface PublicChatStaffMessagePage {
  messages: PublicChatStaffMessage[];
  last_seq: number;
}

/**
 * API-220/221 row. There are no `room_members` rows in this context: every
 * active workspace member sees every row (FR-PCHAT-004), so there is no
 * `my_role`. `code` is deliberately ABSENT — the visitor's credential is the
 * partner's to deliver, not something an agent list needs to carry.
 */
export interface PublicChatStaffRoom {
  id: string;
  customer_name: string;
  provider_name: string;
  external_ref: string | null;
  status: PublicChatStatus;
  /** The same projection the customer sees, so both surfaces can be compared. */
  status_public: PublicChatStatusPublic;
  locale: PublicChatLocale;
  assigned_to: PublicChatAgentStub | null;
  claimed_at: string | null;
  /** MANDATORY graft 21 — stamped once by the auto-claim UPDATE, never rewritten. */
  first_response_at: string | null;
  /** `last_visitor_seq > last_agent_seq && status !== 'done'` — the amber dot. */
  needs_reply: boolean;
  last_seq: number;
  last_visitor_seq: number;
  last_agent_seq: number;
  /** FR-PCHAT-010 — per-agent read pointer; one agent's never affects another's. */
  my_last_read_seq: number;
  unread_count: number;
  last_message_at: string | null;
  created_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  /** The partner's arbitrary payload. NEVER serialised to a visitor. */
  meta: Record<string, unknown> | null;
}

/**
 * API-220 page. `next_cursor` is OPAQUE by contract — v1 encodes a base64
 * offset over the triage sort so it can become a keyset later without an API
 * change. Never parse it; pass it back verbatim.
 */
export interface PublicChatRoomPage {
  rooms: PublicChatStaffRoom[];
  next_cursor: string | null;
}

/**
 * API-227 `summary` — six counters, not four. `done` and `needs_reply` are
 * emitted alongside the three status counts and `mine`; the rail badge itself
 * is `new + problem` (FR-PCHAT-003). `mine` and `needs_reply` both EXCLUDE
 * `done` rooms, so a closed conversation never keeps a badge lit.
 */
export interface PublicChatSummary {
  new: number;
  in_progress: number;
  problem: number;
  done: number;
  mine: number;
  needs_reply: number;
}

/**
 * The full API-227 body. The counters are nested under `summary` and carry
 * `feature_enabled` beside them: this endpoint is a READ and keeps answering
 * with the kill switch off (FR-PCHAT-034), so the rail can show a "paused" chip
 * instead of vanishing.
 */
export interface PublicChatSummaryResponse {
  summary: PublicChatSummary;
  feature_enabled: boolean;
}

/** API-228 response — monotonic; a lower seq is a no-op, and the server reports the pointer ACTUALLY in force. */
export interface PublicChatReadState {
  room_id: string;
  last_read_seq: number;
  unread_count: number;
}

/** API-220 `assigned`: a member ULID, or the two symbolic values. */
export type PublicChatAssigneeFilter = 'me' | 'none' | (string & {});

/**
 * API-220 query, in WIRE spelling (snake_case). FR-PCHAT-004: every one of
 * these is applied SERVER-SIDE and belongs in the react-query key; the client
 * never filters a page it already fetched.
 */
export interface PublicChatListQuery {
  status?: PublicChatStatus[];
  assigned?: PublicChatAssigneeFilter;
  /** ILIKE over customer_name / provider_name / external_ref AND message bodies. */
  q?: string;
  needs_reply?: boolean;
  cursor?: string;
  limit?: number;
}

/**
 * The list page's own UI state (camelCase — this is not a wire shape).
 * `assignee: 'all'` is the wire's "omit `assigned` entirely".
 */
export interface PublicChatFilters {
  status: PublicChatStatus[];
  assignee: 'all' | PublicChatAssigneeFilter;
  q: string;
  needsReply: boolean;
}

// -- §9 EVT-080..085 --

/** Deliberately a separate union: `RealtimeEventName` above is not widened. */
export type PublicChatEventName =
  | 'public_chat.message.created'
  | 'public_chat.room.changed'
  | 'public_chat.room.created'
  | 'public_chat.message.deleted'
  | 'public_chat.attachment.ready'
  | 'public_chat.attachment.failed'
  | 'public_chat.typing';

/**
 * EVT-084 payload. NOT a full `Attachment`: `AttachmentProcessed::payload()`
 * emits a six-field whitelist keyed `attachment_id` (not `id`), with no signed
 * URLs. The client re-fetches via API-062 / a message reload to get those.
 */
export interface PublicChatAttachmentEvent {
  attachment_id: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  filename: string;
  width: number | null;
  height: number | null;
}

/**
 * Payloads on `private-public-chat.{room_id}` — visitor + agents mirroring.
 * Every room-scoped event carries `room_id` in its own payload rather than
 * relying on the channel name it arrived on.
 */
export interface PublicChatVisitorEventMap {
  'public_chat.message.created': { room_id: string; message: PublicChatPublicMessage };
  /**
   * EVT-081 visitor variant — nested under `room`, and `status_public` +
   * `can_send` ONLY. The visitor never learns who is assigned, or that anyone
   * is.
   */
  'public_chat.room.changed': {
    room: { id: string; status_public: PublicChatStatusPublic; can_send: boolean };
  };
  'public_chat.message.deleted': { room_id: string; message_id: string; seq: number };
  'public_chat.attachment.ready': { attachment: PublicChatAttachmentEvent };
  'public_chat.attachment.failed': { attachment: PublicChatAttachmentEvent };
  /** EVT-085 visitor variant — sender_kind only, never a username. */
  'public_chat.typing': { room_id: string; sender_kind: PublicChatSenderKind };
}

/** Payloads on `private-public-chat-staff.{room_id}` + `private-workspace.{wid}`. */
export interface PublicChatStaffEventMap {
  'public_chat.message.created': { room_id: string; message: PublicChatStaffMessage };
  /**
   * EVT-081 staff variant — the WHOLE staff room, nested under `room`. It also
   * fans out to `private-workspace.{wid}` for queue/badge liveness, where the
   * consumer has no channel-scoped room id to fall back on; `room.id` is what
   * tells it which row to re-sort.
   */
  'public_chat.room.changed': { room: PublicChatStaffRoom };
  'public_chat.room.created': { room: PublicChatStaffRoom };
  'public_chat.message.deleted': { room_id: string; message_id: string; seq: number };
  'public_chat.attachment.ready': { attachment: PublicChatAttachmentEvent };
  'public_chat.attachment.failed': { attachment: PublicChatAttachmentEvent };
  /** EVT-085 staff variant — the typing member, or null for the customer. */
  'public_chat.typing': {
    room_id: string;
    sender_kind: PublicChatSenderKind;
    user: PublicChatAgentStub | null;
  };
}

type PublicChatEnvelopes<M> = { [K in keyof M]: EventEnvelope<M[K]> & { event: K } }[keyof M];

/** Discriminated on `event` — what the visitor page's own Echo instance receives. */
export type PublicChatVisitorEvent = PublicChatEnvelopes<PublicChatVisitorEventMap>;
/** Discriminated on `event` — what the agent page receives via the shared Echo. */
export type PublicChatStaffEvent = PublicChatEnvelopes<PublicChatStaffEventMap>;
