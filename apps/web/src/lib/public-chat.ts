/**
 * FR-PCHAT — the web app's view of the Public Chat wire contract.
 *
 * WHY THIS FILE EXISTS RATHER THAN IMPORTING THE SHAPES FROM @banana-chat/shared:
 * the shapes in `packages/shared/src/types.ts` were written against an earlier
 * revision of the contract and do not match what the API actually serialises
 * today (verified against `PublicChatPublicSerializer`, `PublicChatStaffSerializer`
 * and `PublicChatAgentController`):
 *
 *   - API-210 `room` carries `id` (the visitor page needs the ULID to subscribe
 *     to private-public-chat.{id} — it cannot derive it from its code), plus
 *     `expires_at` and `last_seq`. Shared says `code` and omits the other two.
 *   - The public message field is `display_name`, not `sender_name`, and the
 *     tombstone flag is `deleted: boolean`, not `deleted_at`.
 *   - API-222 answers `{messages, last_seq}` ascending, not `{has_more_*}`.
 *   - API-227 answers `{summary:{…, done, needs_reply}, feature_enabled}`, so
 *     `Endpoints.publicChatSummary()`'s own return type is one level off.
 *   - The staff room row carries `needs_reply` and `status_public`.
 *   - Both `public_chat.room.changed` payloads are nested under `room`.
 *
 * `packages/*` belongs to another agent, so the drift is reported rather than
 * edited here. Everything below mirrors the SERVER, and every call still goes
 * through `Endpoints` so the `pchatQuery()` serialisation (csv `status`,
 * `needs_reply=1`, no literal "undefined") stays in one place.
 *
 * NOTHING IN HERE IS PLATFORM-AGNOSTIC LOGIC — all of that lives in
 * @banana-chat/chat-core per CLAUDE.md. This file is wire shapes and transport.
 */
import { ApiError } from '@banana-chat/api-client';
import { t } from '@banana-chat/shared';
import type {
  Attachment,
  AttachmentStatus,
  Locale,
  PublicChatLocale,
  PublicChatMessageType,
  PublicChatSenderKind,
  PublicChatStatus,
  PublicChatStatusPublic,
  PublicChatSystemEvent,
  UploadTicket,
  UserStub,
} from '@banana-chat/shared';
import { api, endpoints } from './api';

// ---------------------------------------------------------------- wire shapes

/** API-210 `room`. NO raw `status`, NO `meta`, NO assignee, NO code echo. */
export interface PcVisitorRoom {
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
export interface PcViewer {
  kind: 'member';
  display_name: string;
}

export interface PcVisitorView {
  room: PcVisitorRoom;
  viewer: PcViewer | null;
  feature_enabled: boolean;
  can_send: boolean;
  closed_reason: 'done' | 'disabled' | null;
}

/** Snippet only — the public variant carries no author at all. */
export interface PcReplySnippet {
  id: string;
  seq: number;
  snippet: string | null;
  /** staff variant only */
  sender_kind?: PublicChatSenderKind;
}

/** API-211/212 + EVT-080 on private-public-chat.{rid}. */
export interface PcPublicMessage {
  id: string;
  seq: number;
  sender_kind: PublicChatSenderKind;
  /** Assembled SERVER-SIDE. Render as a text node — never Markdown (fix 20). */
  display_name: string | null;
  type: PublicChatMessageType;
  body: string | null;
  system_event: PublicChatSystemEvent | null;
  /** Projected through status_public; never carries actor_username. */
  system_meta: { from?: PublicChatStatusPublic; to?: PublicChatStatusPublic } | null;
  reply_to: PcReplySnippet | null;
  attachments: Attachment[];
  deleted: boolean;
  created_at: string | null;
}

export interface PcVisitorMessagePage {
  messages: PcPublicMessage[];
  last_seq: number;
}

/** API-222/223 + EVT-080 on private-public-chat-staff.{rid}. */
export interface PcStaffMessage {
  id: string;
  room_id: string;
  seq: number;
  sender_kind: PublicChatSenderKind;
  sender: UserStub | null;
  /** The exact string the customer sees for an agent row. */
  external_display_name: string | null;
  visitor_display_name: string | null;
  type: PublicChatMessageType;
  body: string | null;
  system_event: PublicChatSystemEvent | null;
  /**
   * RAW, staff-side. Two shapes, by event: `status_changed` /
   * `closed_by_customer` carry the two raw statuses in {from,to}; `claimed` /
   * `reassigned` carry member ULIDs in {from_user_id,to_user_id}. Both may
   * carry `actor_username`.
   */
  system_meta: { from?: string; to?: string; from_user_id?: string; to_user_id?: string; actor_username?: string } | null;
  reply_to: PcReplySnippet | null;
  attachments: Attachment[];
  client_message_id: string;
  deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string | null;
}

export interface PcStaffMessagePage {
  messages: PcStaffMessage[];
  last_seq: number;
}

/**
 * API-220 row / API-221 / EVT-081 staff / EVT-082. Structurally satisfies
 * chat-core's `PublicChatRoomLike`, so the queue sort, the filter predicate and
 * `needsReply()` all take it as-is. The 64-hex `code` is deliberately absent.
 */
export interface PcStaffRoom {
  id: string;
  customer_name: string;
  provider_name: string;
  external_ref: string | null;
  status: PublicChatStatus;
  status_public: PublicChatStatusPublic;
  locale: PublicChatLocale;
  assigned_to: { id: string; username: string; display_name: string } | null;
  claimed_at: string | null;
  first_response_at: string | null;
  needs_reply: boolean;
  last_seq: number;
  last_visitor_seq: number;
  last_agent_seq: number;
  my_last_read_seq: number;
  unread_count: number;
  last_message_at: string | null;
  created_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  meta?: Record<string, unknown> | null;
}

export interface PcRoomPage {
  rooms: PcStaffRoom[];
  /** OPAQUE by contract — v1 encodes an offset, so never parse it. */
  next_cursor: string | null;
}

export interface PcSummary {
  new: number;
  in_progress: number;
  problem: number;
  done: number;
  mine: number;
  needs_reply: number;
}

export interface PcSummaryResponse {
  summary: PcSummary;
  feature_enabled: boolean;
}

export interface PcReadState {
  room_id: string;
  last_read_seq: number;
  unread_count: number;
}

export interface PcListFilters {
  status: PublicChatStatus[];
  assignee: 'all' | 'me' | 'none' | string;
  q: string;
  needsReply: boolean;
}

/**
 * API-213 / API-225 DO NOT answer with the API-060 `UploadTicket` shape — they
 * send `{attachment:{id,status}, upload_url, multipart?}` where the media
 * pipeline's own endpoint sends `{attachment_id, put_url, headers, expires_at}`.
 * Normalising here rather than at three call sites is what lets the chunked-PUT
 * helper (`uploadTicket()` in chat-core) and `useUploader` stay shared between
 * the internal composer and both Public Chat surfaces.
 */
interface PcUploadTicketWire {
  attachment: { id: string; status: AttachmentStatus };
  upload_url?: string | null;
  multipart?: { upload_id: string; part_size: number; part_urls: string[] } | null;
}

function toUploadTicket(raw: PcUploadTicketWire): UploadTicket {
  return {
    attachment_id: raw.attachment.id,
    put_url: raw.upload_url ?? null,
    multipart: raw.multipart ?? null,
    // the same header API-060 sends; the local-disk sink and an S3 presigned PUT
    // both accept the opaque body
    headers: { 'Content-Type': 'application/octet-stream' },
    // API-213/225 do not send an expiry; the server's ticket lifetime is 15
    // minutes (UploadController API-060), and nothing on the upload path reads
    // this field — it exists to satisfy the shared ticket shape.
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

// ------------------------------------------------------------------ transport

/** The api-client generics predate the current contract; re-type at the seam. */
function as<T>(promise: Promise<unknown>): Promise<T> {
  return promise as Promise<T>;
}

export const pchat = {
  // -- tier 2, the visitor. No workspace slug; the code in the path IS the credential.
  visitorView: (code: string) => as<PcVisitorView>(endpoints.publicChatVisitorView(code)),

  visitorMessages: (code: string, params: { after_seq?: number; limit?: number } = {}) =>
    as<PcVisitorMessagePage>(endpoints.publicChatVisitorMessages(code, params)),

  visitorSend: (code: string, input: { client_message_id: string; body?: string; attachment_ids?: string[] }) =>
    as<{ message: PcPublicMessage }>(endpoints.publicChatVisitorSend(code, input)),

  visitorUpload: (code: string, input: { kind: 'image' | 'video' | 'file'; filename: string; mime_type: string; size_bytes: number }) =>
    as<PcUploadTicketWire>(endpoints.publicChatVisitorUpload(code, input)).then(toUploadTicket),

  /** API-214 answers `{attachment:{id,status}}` — a status, not a full row. */
  visitorCompleteUpload: (code: string, attachmentId: string, parts?: { part_number: number; etag: string }[]) =>
    as<{ attachment: { id: string; status: AttachmentStatus } }>(
      endpoints.publicChatVisitorCompleteUpload(code, attachmentId, parts),
    ),

  visitorBroadcastAuth: (code: string, socketId: string, channelName: string) =>
    as<{ auth: string }>(endpoints.publicChatVisitorBroadcastAuth(code, socketId, channelName)),

  visitorTyping: (code: string, typing: boolean) => endpoints.publicChatVisitorTyping(code, typing),

  // -- tier 3, the agent. Ordinary auth + X-Workspace-Id.
  rooms: (slug: string, filters: PcListFilters, cursor?: string) =>
    as<PcRoomPage>(
      endpoints.publicChatRooms(slug, {
        status: filters.status.length > 0 ? filters.status : undefined,
        assigned: filters.assignee === 'all' ? undefined : filters.assignee,
        q: filters.q.trim() === '' ? undefined : filters.q.trim(),
        needs_reply: filters.needsReply ? true : undefined,
        cursor,
      }),
    ),

  room: (slug: string, roomId: string) => as<{ room: PcStaffRoom }>(endpoints.publicChatRoom(slug, roomId)),

  messages: (slug: string, roomId: string, params: { after_seq?: number; before_seq?: number; limit?: number } = {}) =>
    as<PcStaffMessagePage>(endpoints.publicChatMessages(slug, roomId, params)),

  send: (
    slug: string,
    roomId: string,
    input: { client_message_id: string; body?: string; reply_to_message_id?: string; attachment_ids?: string[] },
  ) => as<{ message: PcStaffMessage }>(endpoints.publicChatSend(slug, roomId, input)),

  /**
   * API-224. Presence of the KEY requests the change — `assigned_to: null` is an
   * explicit unassign, and omitting it leaves the assignee alone.
   */
  updateRoom: (slug: string, roomId: string, patch: { status?: PublicChatStatus; assigned_to?: string | null }) =>
    as<{ room: PcStaffRoom }>(endpoints.publicChatUpdateRoom(slug, roomId, patch)),

  createUpload: (
    slug: string,
    roomId: string,
    input: { kind: 'image' | 'video' | 'file'; filename: string; mime_type: string; size_bytes: number },
  ) => as<PcUploadTicketWire>(endpoints.publicChatCreateUpload(slug, roomId, input)).then(toUploadTicket),

  deleteMessage: (slug: string, messageId: string) => endpoints.publicChatDeleteMessage(slug, messageId),

  summary: (slug: string) => as<PcSummaryResponse>(endpoints.publicChatSummary(slug)),

  markRead: (slug: string, roomId: string, seq: number) => as<PcReadState>(endpoints.publicChatMarkRead(slug, roomId, seq)),

  /**
   * The extra agent typing route (POST /public-chat/rooms/{id}/typing,
   * throttle:pchat-agent-typing). It is not one of the twenty specced API-* ids
   * and `Endpoints` has no method for it, so it is called directly rather than
   * by reaching across the package boundary to add one.
   */
  agentTyping: (slug: string, roomId: string, typing: boolean) =>
    api.request<void>(`/api/v1/public-chat/rooms/${roomId}/typing`, {
      method: 'POST',
      workspaceSlug: slug,
      body: { typing },
    }),
};

// ------------------------------------------------------------------- messages

/**
 * `t()` deliberately does not interpolate (see packages/shared/src/i18n.ts), so
 * every app does its own `{placeholder}` substitution — the same way the room
 * secret-days string is already handled.
 */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Server errors arrive as codes (§7 envelope). Map the ones this feature can
 * produce onto the pchat.error.* catalog and fall back to a generic sentence —
 * never surface a raw server message on the customer-facing page.
 */
export function pchatErrorMessage(error: unknown, locale: Locale = 'en'): string {
  if (error instanceof ApiError) {
    const known = [
      'PCHAT_ROOM_NOT_FOUND',
      'PCHAT_LINK_EXPIRED',
      'PCHAT_ROOM_CLOSED',
      'PCHAT_DISABLED',
      'PCHAT_SIGNED_IN',
      'PCHAT_INVALID_TRANSITION',
      'RATE_LIMITED',
    ];
    if (known.includes(error.code)) {
      return t(`pchat.error.${error.code}`, locale);
    }
    if (error.status === 404) return t('pchat.error.PCHAT_ROOM_NOT_FOUND', locale);
    if (error.status === 410) return t('pchat.error.PCHAT_LINK_EXPIRED', locale);
    if (error.status === 409) return t('pchat.error.PCHAT_ROOM_CLOSED', locale);
    if (error.status === 429) return t('pchat.error.RATE_LIMITED', locale);
  }
  return t('pchat.error.generic', locale);
}

/** Short local time for a transcript row. */
export function pchatTime(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function pchatRelative(iso: string | null): string {
  if (iso === null) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Merge a page or an event into a seq-ordered transcript. Events, the 5s poll
 * fallback and the optimistic insert all land here, so a message that arrives
 * twice renders once.
 */
export function mergeBySeq<T extends { id: string; seq: number }>(current: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return current as T[];
  const byId = new Map<string, T>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}
