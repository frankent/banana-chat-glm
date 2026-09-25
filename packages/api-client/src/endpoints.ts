import type { PublicMeeting, MeetingLobby, MeetingJoin } from '@banana-chat/shared';
import type { RoomCall, CallJoin } from '@banana-chat/shared';
import type { KanbanLane, KanbanTicket, TicketDetail, TicketInput } from '@banana-chat/shared';
import type {
  RoomNote,
  AiConversationSummary,
  AiMemory,
  AiMemoryCategory,
  AiMessage,
  AiMessagePage,
  AiRegenerateResponse,
  AiSearchResult,
  AiSendResponse,
  AiShareResponse,
  ForwardMessagesResponse,
  AiStatus,
  Attachment,
  AppConfig,
  FileSearchResult,
  InAppNotification,
  JoinInvitePreview,
  Message,
  MessagePage,
  MessageSearchResult,
  ReadStatusEntry,
  PublicChatListQuery,
  PublicChatPublicMessage,
  PublicChatReadState,
  PublicChatRoomPage,
  PublicChatStaffMessage,
  PublicChatStaffMessagePage,
  PublicChatStaffRoom,
  PublicChatStatus,
  PublicChatSummaryResponse,
  PublicChatUploadCompletion,
  PublicChatUploadTicket,
  PublicChatVisitorMessagePage,
  PublicChatVisitorView,
  RoomListItem,
  SearchPage,
  UploadTicket,
  UserStub,
  WorkspaceInvite,
  WorkspaceSummary,
} from '@banana-chat/shared';
import type { ApiClient } from './client.js';

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: UserStub & { locale: string; timezone: string; must_change_password: boolean };
  workspaces: WorkspaceSummary[];
}

export interface RoomDetail {
  room: RoomListItem['room'];
  my_role: RoomListItem['my_role'];
  other_user: RoomListItem['other_user'];
  unread_count: number;
}

/**
 * FR-ROOM-012 — secret-room creation options. `secret: true` requires
 * `expiryDays` 1..30 (server-validated); omit or pass `secret: false` for an
 * ordinary room.
 */
export interface SecretRoomOptions {
  secret?: boolean;
  expiryDays?: number;
}

function secretBody(opts?: SecretRoomOptions): Record<string, unknown> {
  if (opts?.secret !== true) {
    return {};
  }
  return { secret: true, expiry_days: opts.expiryDays };
}

/**
 * §5.18 FR-PCHAT — public support chat (§8.10). Two of the three tiers live
 * here; the partner tier (API-200..203) deliberately does NOT, because it is
 * HMAC-signed server-to-server and signing from browser JavaScript would ship
 * the partner secret to every visitor (MANDATORY graft 10).
 *
 * Attachment kinds a public chat upload may request. `avatar` is absent by
 * construction: the server rejects it 422 before UploadService is reached
 * (FR-PCHAT-020), and there is no reason for a client to be able to ask.
 */
export type PublicChatUploadKind = 'image' | 'video' | 'file';

export interface PublicChatUploadInput {
  kind: PublicChatUploadKind;
  filename: string;
  mime_type: string;
  size_bytes: number;
}

export interface PublicChatVisitorSendInput {
  /**
   * FR-PCHAT-011 — REQUIRED on the visitor tier (unlike the member endpoint,
   * where it is optional) and must be a UUID, else 422. Generate it ONCE per
   * composed message with `crypto.randomUUID()` and reuse the same value on
   * every retry: that is what makes a retry a 200 replay instead of a duplicate.
   */
  client_message_id: string;
  body?: string;
  /** At most 10 (`message.max_attachments`). */
  attachment_ids?: string[];
}

export interface PublicChatAgentSendInput extends PublicChatVisitorSendInput {
  /** MANDATORY graft 4 — inline reply/quote within the same room (NG4, no threads). */
  reply_to_message_id?: string;
}

export interface PublicChatRoomPatch {
  status?: PublicChatStatus;
  /** A ULID of an active member of the same workspace, or null to unassign. */
  assigned_to?: string | null;
}

/** Pusher/Reverb channel-auth response — the visitor page feeds this to Echo. */
export interface PublicChatBroadcastAuth {
  auth: string;
}

/**
 * `new URLSearchParams({q: undefined})` serialises the literal string
 * "undefined", which the server would then match against. Drop empty values
 * instead of trusting the caller to omit the key.
 */
function pchatQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** Typed endpoint wrappers — one method per API row in spec §8. */
export class Endpoints {
  constructor(private readonly api: ApiClient) {}

  meetings(slug: string) { return this.api.request<PublicMeeting[]>('/api/v1/meetings', { workspaceSlug: slug }); }
  createMeeting(slug: string, title: string, expires_in_hours: number) { return this.api.request<PublicMeeting>('/api/v1/meetings', { method: 'POST', workspaceSlug: slug, body: {title, expires_in_hours} }); }
  endMeeting(slug: string, id: string) { return this.api.request<void>(`/api/v1/meetings/${id}/end`, {method:'POST', workspaceSlug:slug}); }
  meetingLobby(code: string) { return this.api.request<MeetingLobby>(`/api/v1/public-meetings/${code}`); }
  joinMeeting(code: string, name?: string, participant_token?: string) { return this.api.request<MeetingJoin>(`/api/v1/public-meetings/${code}/join`, {method:'POST', body:{name,participant_token}}); }
  leaveMeeting(code: string, participant_token: string) { return this.api.request<void>(`/api/v1/public-meetings/${code}/leave`, {method:'POST',body:{participant_token}}); }
  calls(slug: string) { return this.api.request<{enabled:boolean; calls:RoomCall[]}>('/api/v1/calls', {workspaceSlug:slug}); }
  startCall(roomId:string, kind:'voice'|'video', slug:string) { return this.api.request<RoomCall>(`/api/v1/rooms/${roomId}/calls`, {method:'POST', body:{kind}, workspaceSlug:slug}); }
  joinCall(id:string, slug:string) { return this.api.request<CallJoin>(`/api/v1/calls/${id}/join`, {method:'POST', workspaceSlug:slug}); }
  callAction(id:string, action:'leave'|'end'|'decline', slug:string) { return this.api.request<void>(`/api/v1/calls/${id}/${action}`, {method:'POST', workspaceSlug:slug}); }

  board(slug: string) { return this.api.request<{lanes: KanbanLane[]; can_manage: boolean}>('/api/v1/board', {workspaceSlug:slug}); }
  boardTickets(slug: string, filters: {q?: string; assignee?: string; priority?: string; cursor?: string} = {}) {
    return this.api.request<{tickets: KanbanTicket[]; next_cursor: string | null}>(`/api/v1/board/tickets?${new URLSearchParams(filters)}`, {workspaceSlug:slug});
  }
  boardTicket(slug: string, id: string, before = '') { return this.api.request<TicketDetail>(`/api/v1/board/tickets/${id}${before ? `?before=${before}` : ''}`, {workspaceSlug:slug}); }
  createTicket(slug: string, input: TicketInput) { return this.api.request<KanbanTicket>('/api/v1/board/tickets', {method:'POST',workspaceSlug:slug,body:input}); }
  updateTicket(slug: string, id: string, input: Partial<TicketInput> & {version: number}) { return this.api.request<KanbanTicket>(`/api/v1/board/tickets/${id}`, {method:'PATCH',workspaceSlug:slug,body:input}); }
  commentTicket(slug: string, id: string, body: string) { return this.api.request(`/api/v1/board/tickets/${id}/comments`, {method:'POST',workspaceSlug:slug,body:{body}}); }
  saveBoardLane(slug: string, input: Partial<KanbanLane>, id?: string) { return this.api.request<KanbanLane>(`/api/v1/board/lanes${id ? `/${id}` : ''}`, {method:id?'PATCH':'POST',workspaceSlug:slug,body:input}); }
  deleteBoardLane(slug: string,id: string) { return this.api.request<void>(`/api/v1/board/lanes/${id}`, {method:'DELETE',workspaceSlug:slug}); }


  directoryPage(slug: string, q = '', cursor = '') {
    return this.api.request<{members: UserStub[]; next_cursor: string | null}>(`/api/v1/directory?q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(cursor)}`, {workspaceSlug: slug});
  }
  notes(roomId: string, slug: string, before = '') {
    return this.api.request<{notes: RoomNote[]; has_more: boolean}>(`/api/v1/rooms/${roomId}/notes${before ? '?before='+before : ''}`, {workspaceSlug: slug});
  }
  createNote(roomId: string, slug: string, body: string, attachment_ids: string[]) {
    return this.api.request<RoomNote>(`/api/v1/rooms/${roomId}/notes`, {method:'POST', workspaceSlug:slug, body:{body, attachment_ids}});
  }
  updateNote(roomId: string, slug: string, id: string, body: string) {
    return this.api.request<RoomNote>(`/api/v1/rooms/${roomId}/notes/${id}`, {method:'PATCH', workspaceSlug:slug, body:{body}});
  }
  deleteNote(roomId: string, slug: string, id: string) {
    return this.api.request<void>(`/api/v1/rooms/${roomId}/notes/${id}`, {method:'DELETE', workspaceSlug:slug});
  }
  pins(roomId: string, slug: string) { return this.api.request<Message[]>(`/api/v1/rooms/${roomId}/pins`, {workspaceSlug:slug}); }
  pin(roomId: string, slug: string, id: string, pinned: boolean) {
    return this.api.request<void>(`/api/v1/rooms/${roomId}/pins/${id}`, {method:pinned ? 'PUT' : 'DELETE', workspaceSlug:slug});
  }
  typing(roomId: string, slug: string, typing: boolean) { return this.api.request<void>(`/api/v1/rooms/${roomId}/typing`, {method:'POST', workspaceSlug:slug, body:{typing}}); }

  // -- auth (API-001..010) --

  login(username: string, password: string, device: { platform: string; name: string }) {
    return this.api.request<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: { username, password, device },
    });
  }

  logout() {
    return this.api.request<void>('/api/v1/auth/logout', { method: 'POST' });
  }

  logoutAll() {
    return this.api.request<void>('/api/v1/auth/logout-all', { method: 'POST' });
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.api.request<void>('/api/v1/auth/change-password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    });
  }

  me() {
    return this.api.request<{ user: UserStub & { locale: string }; settings: { locale: string; timezone: string; notification: {sound?: boolean} | null } }>('/api/v1/me');
  }

  myWorkspaces() {
    return this.api.request<WorkspaceSummary[]>('/api/v1/me/workspaces');
  }

  /** API-234, FR-ADM-015/DEC-082 — PUBLIC, pre-auth: /login and /join/:token render it too. */
  appConfig() {
    return this.api.request<AppConfig>('/api/v1/app-config');
  }

  // -- workspace (API-011..014) --

  directory(q = '', slug: string) {
    return this.api.request<UserStub[]>(`/api/v1/members?q=${encodeURIComponent(q)}`, { workspaceSlug: slug });
  }

  // -- rooms (API-020..039) --

  rooms(slug: string, filter?: 'all' | 'unread' | 'hidden') {
    const query = filter !== undefined ? `?filter=${filter}` : '';
    return this.api.request<RoomListItem[]>(`/api/v1/rooms${query}`, { workspaceSlug: slug });
  }

  createDm(userId: string, slug: string, secret?: SecretRoomOptions) {
    return this.api.request<RoomDetail>('/api/v1/rooms', {
      method: 'POST',
      body: { type: 'dm', user_id: userId, ...secretBody(secret) },
      workspaceSlug: slug,
    });
  }

  createGroup(name: string, memberIds: string[], slug: string, description?: string, secret?: SecretRoomOptions) {
    return this.api.request<RoomDetail>('/api/v1/rooms', {
      method: 'POST',
      body: { type: 'group', name, member_ids: memberIds, description, ...secretBody(secret) },
      workspaceSlug: slug,
    });
  }

  room(roomId: string, slug: string) {
    return this.api.request<RoomDetail>(`/api/v1/rooms/${roomId}`, { workspaceSlug: slug });
  }

  /** Room roster for @mention autocomplete (flat cursor-paginated array, API-024). */
  roomMembers(roomId: string, slug: string) {
    return this.api.request<Array<UserStub & { role: string }>>(`/api/v1/rooms/${roomId}/members?limit=100`, { workspaceSlug: slug });
  }

  // -- messages (API-040/041) --

  messages(roomId: string, slug: string, params: { before_seq?: number; after_seq?: number; around_seq?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.before_seq !== undefined) query.set('before_seq', String(params.before_seq));
    if (params.after_seq !== undefined) query.set('after_seq', String(params.after_seq));
    if (params.around_seq !== undefined) query.set('around_seq', String(params.around_seq));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.api.request<MessagePage>(`/api/v1/rooms/${roomId}/messages${qs !== '' ? `?${qs}` : ''}`, { workspaceSlug: slug });
  }

  sendMessage(
    roomId: string,
    slug: string,
    body: string | null,
    clientMessageId: string,
    replyToMessageId?: string,
    attachmentIds: string[] = [],
  ) {
    return this.api.request<{ message: Message }>(`/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      body: {
        client_message_id: clientMessageId,
        body,
        reply_to_message_id: replyToMessageId,
        ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
      },
      workspaceSlug: slug,
    });
  }

  // -- edit/delete (API-042/043) --

  /** API-042 — sender-only body edit (FR-MSG-005). */
  editMessage(messageId: string, slug: string, body: string) {
    return this.api.request<{ message: Message }>(`/api/v1/messages/${messageId}`, {
      method: 'PATCH',
      body: { body },
      workspaceSlug: slug,
    });
  }

  /** API-043 — soft delete, 204 (FR-MSG-006). */
  deleteMessage(messageId: string, slug: string) {
    return this.api.request<void>(`/api/v1/messages/${messageId}`, {
      method: 'DELETE',
      workspaceSlug: slug,
    });
  }

  // -- mentions (API-044) --

  /** API-044 — messages mentioning me in the workspace, newest first. */
  myMentions(slug: string, cursor?: string) {
    const qs = cursor !== undefined ? `?cursor=${cursor}` : '';
    return this.api.request<{ messages: Message[]; next_cursor: string | null }>(`/api/v1/me/mentions${qs}`, { workspaceSlug: slug });
  }

  // -- media (API-060/061/062) --

  createUpload(
    slug: string,
    input: { kind: 'image' | 'video' | 'file' | 'avatar'; filename: string; mime_type: string; size_bytes: number; sha256?: string },
  ) {
    return this.api.request<UploadTicket>('/api/v1/uploads', {
      method: 'POST',
      body: input,
      workspaceSlug: slug,
    });
  }

  completeUpload(attachmentId: string, slug: string, parts?: { part_number: number; etag: string }[]) {
    return this.api.request<{ attachment: Attachment }>(`/api/v1/uploads/${attachmentId}/complete`, {
      method: 'POST',
      body: parts === undefined ? undefined : { parts },
      workspaceSlug: slug,
    });
  }

  attachment(attachmentId: string, slug: string) {
    return this.api.request<{ attachment: Attachment }>(`/api/v1/attachments/${attachmentId}`, {
      workspaceSlug: slug,
    });
  }

  // -- notifications (API-070/071/072) --

  /** API-070 — upsert this device's push token (FR-NOTI-001). */
  updateDevice(
    deviceId: string,
    input: {
      push_token?: string | null;
      push_provider?: 'fcm' | 'apns' | null;
      platform: 'ios' | 'android' | 'web';
      app_version?: string | null;
      device_name?: string | null;
      locale?: string | null;
    },
  ) {
    return this.api.request<{ device: { id: string; push_token: string | null } }>(`/api/v1/me/devices/${deviceId}`, {
      method: 'PUT',
      body: input,
    });
  }

  /**
   * API-074 — focus ping so the server can silence a push for the room this device
   * is already reading (FR-NOTI-002). Workspace-agnostic; room_id null means "not
   * looking at any room".
   */
  reportFocus(deviceId: string, roomId: string | null) {
    return this.api.request<void>('/api/v1/me/focus', {
      method: 'POST',
      body: { device_id: deviceId, room_id: roomId },
    });
  }

  /** API-071 — per-room notification mode (FR-NOTI-005). */
  roomNotificationSettings(roomId: string, slug: string, input: { mode: 'all' | 'mentions' | 'none'; muted_until?: string | null }) {
    return this.api.request<{ settings: unknown }>(`/api/v1/rooms/${roomId}/notifications`, {
      method: 'PUT',
      body: input,
      workspaceSlug: slug,
    });
  }

  /** API-072 — user notification settings (DND, sound, preview). */
  notificationSettings(slug: string, input: { dnd_start?: string | null; dnd_end?: string | null; dnd_days?: number[]; sound?: boolean; preview_in_push?: boolean }) {
    return this.api.request<{ settings: unknown }>('/api/v1/me/notification-settings', {
      method: 'PUT',
      body: input,
      workspaceSlug: slug,
    });
  }

  // -- notification center (API-073) --

  /** FR-NOTI-006 — in-app notification feed, newest first. */
  myNotifications(slug: string, cursor?: string) {
    const query = cursor !== undefined && cursor !== '' ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.api.request<{ notifications: InAppNotification[]; next_cursor: string | null }>(
      `/api/v1/me/notifications${query}`,
      { workspaceSlug: slug },
    );
  }

  /** FR-NOTI-006 — mark read: given ids, or all unread when omitted. */
  markNotificationsRead(slug: string, ids?: string[]) {
    return this.api.request<{ ok: boolean }>('/api/v1/me/notifications/read', {
      method: 'POST',
      body: ids !== undefined && ids.length > 0 ? { ids } : {},
      workspaceSlug: slug,
    });
  }

  // -- search (API-080/081) --

  /** API-080 — message search (FR-SRCH-001). q >= 2 chars server-side. */
  searchMessages(
    slug: string,
    input: { q: string; room_id?: string; sender_id?: string; from?: string; to?: string; type?: string; cursor?: string },
  ) {
    const query = new URLSearchParams();
    query.set('q', input.q);
    if (input.room_id) query.set('room_id', input.room_id);
    if (input.sender_id) query.set('sender_id', input.sender_id);
    if (input.from) query.set('from', input.from);
    if (input.to) query.set('to', input.to);
    if (input.type) query.set('type', input.type);
    if (input.cursor) query.set('cursor', input.cursor);
    return this.api.request<SearchPage<MessageSearchResult>>(`/api/v1/search/messages?${query}`, {
      workspaceSlug: slug,
    });
  }

  /** API-081 — file search by original_name (FR-SRCH-002); also backs the room media tab. */
  searchFiles(slug: string, input: { q: string; kind?: 'image' | 'video' | 'file'; room_id?: string; cursor?: string }) {
    const query = new URLSearchParams();
    query.set('q', input.q);
    if (input.kind) query.set('kind', input.kind);
    if (input.room_id) query.set('room_id', input.room_id);
    if (input.cursor) query.set('cursor', input.cursor);
    return this.api.request<SearchPage<FileSearchResult>>(`/api/v1/search/files?${query}`, { workspaceSlug: slug });
  }

  // -- read (API-045/046) --

  markRead(roomId: string, slug: string, seq: number) {
    return this.api.request<{ last_read_seq: number }>(`/api/v1/rooms/${roomId}/read`, {
      method: 'POST',
      body: { seq },
      workspaceSlug: slug,
    });
  }

  readStatus(roomId: string, slug: string, seq?: number) {
    const query = seq !== undefined ? `?seq=${seq}` : '';
    return this.api.request<{ seq: number; read_by: ReadStatusEntry[] }>(`/api/v1/rooms/${roomId}/read-status${query}`, { workspaceSlug: slug });
  }

  // -- workspace invites (API-230..233, FR-WS-006/FR-AUTH-008, DEC-081) --

  createWorkspaceInvite(slug: string) {
    return this.api.request<WorkspaceInvite>('/api/v1/workspace-invites', { method: 'POST', workspaceSlug: slug });
  }
  revokeWorkspaceInvite(slug: string, id: string) {
    return this.api.request<void>(`/api/v1/workspace-invites/${id}`, { method: 'DELETE', workspaceSlug: slug });
  }
  /** PUBLIC — no auth, no workspace header. Callable repeatedly. */
  joinInvitePreview(token: string) {
    return this.api.request<JoinInvitePreview>(`/api/v1/join/${token}`);
  }
  /** PUBLIC — creates the account, joins as member, and logs the caller in (LoginResponse shape). */
  redeemInvite(token: string, username: string, password: string, displayName: string, device: { platform: string; name: string }, locale?: 'th' | 'en') {
    return this.api.request<LoginResponse>(`/api/v1/join/${token}`, {
      method: 'POST',
      body: { username, password, display_name: displayName, device, locale },
    });
  }

  // -- ai (API-100..113/117/118, §5.14) --

  aiStatus(slug: string) {
    return this.api.request<AiStatus>('/api/v1/ai/status', { workspaceSlug: slug });
  }

  aiConsent() {
    return this.api.request<void>('/api/v1/ai/consent', { method: 'POST' });
  }

  aiConversations(slug: string, opts: { archived?: boolean; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (opts.archived) query.set('archived', '1');
    if (opts.cursor) query.set('cursor', opts.cursor);
    const qs = query.toString();
    return this.api.request<{ conversations: AiConversationSummary[]; next_cursor: string | null }>(
      `/api/v1/ai/conversations${qs !== '' ? `?${qs}` : ''}`,
      { workspaceSlug: slug },
    );
  }

  aiCreateConversation(slug: string, title?: string) {
    return this.api.request<{ conversation: AiConversationSummary }>('/api/v1/ai/conversations', {
      method: 'POST',
      body: title !== undefined ? { title } : {},
      workspaceSlug: slug,
    });
  }

  aiUpdateConversation(conversationId: string, slug: string, patch: { title?: string | null; archived?: boolean }) {
    return this.api.request<{ conversation: AiConversationSummary }>(`/api/v1/ai/conversations/${conversationId}`, {
      method: 'PATCH',
      body: patch,
      workspaceSlug: slug,
    });
  }

  aiDeleteConversation(conversationId: string, slug: string) {
    return this.api.request<void>(`/api/v1/ai/conversations/${conversationId}`, {
      method: 'DELETE',
      workspaceSlug: slug,
    });
  }

  aiMessages(conversationId: string, slug: string, params: { before_seq?: number; limit?: number; include_superseded?: boolean } = {}) {
    const query = new URLSearchParams();
    if (params.before_seq !== undefined) query.set('before_seq', String(params.before_seq));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.include_superseded) query.set('include_superseded', '1');
    const qs = query.toString();
    return this.api.request<AiMessagePage>(`/api/v1/ai/conversations/${conversationId}/messages${qs !== '' ? `?${qs}` : ''}`, {
      workspaceSlug: slug,
    });
  }

  /** API-106 — 202 (or 200 replay). client_message_id must be a UUID. */
  aiSend(conversationId: string, slug: string, content: string, clientMessageId: string) {
    return this.api.request<AiSendResponse>(`/api/v1/ai/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { client_message_id: clientMessageId, content },
      workspaceSlug: slug,
    });
  }

  /** API-117 — partial stream state while live. */
  aiShowMessage(messageId: string) {
    return this.api.request<{ message: AiMessage; partial_content: string | null; last_index: number | null }>(
      `/api/v1/ai/messages/${messageId}`,
    );
  }

  /** API-108 — FR-AI-004 cancel. */
  aiCancel(messageId: string, slug: string) {
    return this.api.request<{ message: AiMessage }>(`/api/v1/ai/messages/${messageId}/cancel`, {
      method: 'POST',
      workspaceSlug: slug,
    });
  }

  /** API-114 — FR-AI-009 regenerate the latest assistant message. */
  aiRegenerate(messageId: string, slug: string) {
    return this.api.request<AiRegenerateResponse>(`/api/v1/ai/messages/${messageId}/regenerate`, {
      method: 'POST',
      workspaceSlug: slug,
    });
  }

  /** API-115 — FR-AI-009 edit the latest user message and re-send. */
  aiEditMessage(messageId: string, slug: string, content: string) {
    return this.api.request<AiSendResponse>(`/api/v1/ai/messages/${messageId}`, {
      method: 'PATCH',
      body: { content },
      workspaceSlug: slug,
    });
  }

  /** FR-AI-015 — share an assistant answer into a room. */
  /** API-047 — FR-MSG-011 forward messages into other rooms; reuse clientForwardId on retry */
  forwardMessages(
    slug: string,
    input: { clientForwardId: string; sourceRoomId: string; messageIds: string[]; roomIds: string[] },
  ) {
    return this.api.request<ForwardMessagesResponse>('/api/v1/messages/forward', {
      method: 'POST',
      body: {
        client_forward_id: input.clientForwardId,
        source_room_id: input.sourceRoomId,
        message_ids: input.messageIds,
        room_ids: input.roomIds,
      },
      workspaceSlug: slug,
    });
  }

  aiShare(messageId: string, slug: string, roomId: string) {
    return this.api.request<AiShareResponse>(`/api/v1/ai/messages/${messageId}/share`, {
      method: 'POST',
      body: { room_id: roomId },
      workspaceSlug: slug,
    });
  }

  /** API-116 — FR-AI-020 search own AI conversations (q ≥ 2 chars). */
  aiSearch(slug: string, q: string, cursor?: string) {
    const query = new URLSearchParams({ q });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.api.request<{ results: AiSearchResult[]; next_cursor: string | null }>(
      `/api/v1/ai/search?${query.toString()}`,
      { workspaceSlug: slug },
    );
  }

  /** API-118 — focus ping for push suppression. */
  aiFocus(conversationId: string, slug: string, focused: boolean) {
    return this.api.request<void>(`/api/v1/ai/conversations/${conversationId}/focus`, {
      method: 'POST',
      body: { focused },
      workspaceSlug: slug,
    });
  }

  aiMemories(slug: string, category?: AiMemoryCategory) {
    const qs = category !== undefined ? `?category=${category}` : '';
    return this.api.request<{ memories: AiMemory[] }>(`/api/v1/ai/memories${qs}`, { workspaceSlug: slug });
  }

  /** API-113 — manual add. */
  aiAddMemory(slug: string, content: string, category: AiMemoryCategory) {
    return this.api.request<{ memory: AiMemory }>('/api/v1/ai/memories', {
      method: 'POST',
      body: { content, category },
      workspaceSlug: slug,
    });
  }

  aiDeleteMemory(memoryId: string, slug: string) {
    return this.api.request<void>(`/api/v1/ai/memories/${memoryId}`, {
      method: 'DELETE',
      workspaceSlug: slug,
    });
  }

  aiClearMemories(slug: string) {
    return this.api.request<void>('/api/v1/ai/memories/clear', { method: 'POST', workspaceSlug: slug });
  }
  // ---- §5.18 FR-PCHAT tier 2: the visitor (API-210..216) ----
  //
  // UNAUTHENTICATED: the 64-hex `code` in the path IS the credential (DEC-063),
  // so it never goes in a query string and no `workspaceSlug` is passed — the
  // server resolves the workspace from the room. `ApiClient` still attaches an
  // Authorization header when the browser happens to hold a token, and that is
  // intended: FR-PCHAT-013 needs the server to SEE a member bearer so it can
  // answer `viewer:{kind:'member'}` and refuse the write with 403
  // PCHAT_SIGNED_IN, rather than silently recording an agent as the customer.

  /** API-210 — room, `can_send`, `feature_enabled`, `closed_reason`, `viewer`. */
  publicChatVisitorView(code: string) {
    return this.api.request<PublicChatVisitorView>(`/api/v1/public-chat/${code}`);
  }

  /** API-211 — reconnect catch-up and the 5 s polling fallback. */
  publicChatVisitorMessages(code: string, params: { after_seq?: number; limit?: number } = {}) {
    return this.api.request<PublicChatVisitorMessagePage>(
      `/api/v1/public-chat/${code}/messages${pchatQuery(params)}`,
    );
  }

  /** API-212 — 201 on a first send, 200 with the identical message on replay. */
  publicChatVisitorSend(code: string, input: PublicChatVisitorSendInput) {
    return this.api.request<{ message: PublicChatPublicMessage }>(`/api/v1/public-chat/${code}/messages`, {
      method: 'POST',
      body: input,
    });
  }

  /**
   * API-213 — ticket gets `uploader_id` NULL and `public_chat_room_id` = the room.
   *
   * Answers `PublicChatUploadTicket`, NOT the shared API-060 `UploadTicket`:
   * this tier emits `{attachment:{id,status}, upload_url, multipart?}` with no
   * `headers` / `expires_at`. Callers that want an API-060-shaped ticket must
   * adapt it explicitly — the divergence is real and is reported upstream
   * rather than papered over with a wrong type here.
   */
  publicChatVisitorUpload(code: string, input: PublicChatUploadInput) {
    return this.api.request<PublicChatUploadTicket>(`/api/v1/public-chat/${code}/uploads`, { method: 'POST', body: input });
  }

  /** API-214 — ownership is asserted against the ROOM, not an uploader identity. */
  publicChatVisitorCompleteUpload(code: string, attachmentId: string, parts?: { part_number: number; etag: string }[]) {
    return this.api.request<PublicChatUploadCompletion>(
      `/api/v1/public-chat/${code}/uploads/${attachmentId}/complete`,
      { method: 'POST', body: parts !== undefined ? { parts } : {} },
    );
  }

  /**
   * API-215 — the visitor page's own Echo authorizer. `channelName` must be
   * exactly `private-public-chat.{room.id}`: the server compares it by literal
   * string equality and 403s anything else, including the -staff channel
   * (MANDATORY fix 7/14). Do not build this string by pattern.
   */
  publicChatVisitorBroadcastAuth(code: string, socketId: string, channelName: string) {
    return this.api.request<PublicChatBroadcastAuth>(`/api/v1/public-chat/${code}/broadcasting/auth`, {
      method: 'POST',
      body: { socket_id: socketId, channel_name: channelName },
    });
  }

  /** API-216 — EVT-085; the visitor variant carries sender_kind only. Answers 202 `{ok:true}`. */
  publicChatVisitorTyping(code: string, typing: boolean) {
    return this.api.request<{ ok: boolean }>(`/api/v1/public-chat/${code}/typing`, { method: 'POST', body: { typing } });
  }

  // ---- §5.18 FR-PCHAT tier 3: the support agent (API-220..228) ----
  //
  // Ordinary auth + `X-Workspace-Id`; authorisation is "active member of this
  // workspace", with no room-level role and no `room_members` row.

  /**
   * API-220. FR-PCHAT-004: every filter is serialised here and applied
   * SERVER-SIDE — put the same values in the react-query key and never filter
   * the returned page in memory, or "Problem only" silently means "problem
   * rooms that happened to be on page 1".
   */
  publicChatRooms(slug: string, filters: PublicChatListQuery = {}) {
    const query = pchatQuery({
      status: filters.status !== undefined && filters.status.length > 0 ? filters.status.join(',') : undefined,
      assigned: filters.assigned,
      q: filters.q,
      needs_reply: filters.needs_reply === true ? 1 : undefined,
      cursor: filters.cursor,
      limit: filters.limit,
    });
    return this.api.request<PublicChatRoomPage>(`/api/v1/public-chat/rooms${query}`, { workspaceSlug: slug });
  }

  /** API-221 — the detail row, including `meta`, `my_last_read_seq`, `unread_count`. */
  publicChatRoom(slug: string, roomId: string) {
    return this.api.request<{ room: PublicChatStaffRoom }>(`/api/v1/public-chat/rooms/${roomId}`, { workspaceSlug: slug });
  }

  publicChatMessages(slug: string, roomId: string, params: { after_seq?: number; before_seq?: number; limit?: number } = {}) {
    return this.api.request<PublicChatStaffMessagePage>(
      `/api/v1/public-chat/rooms/${roomId}/messages${pchatQuery(params)}`,
      { workspaceSlug: slug },
    );
  }

  /**
   * API-223 — TRIGGERS AUTO-CLAIM (FR-PCHAT-009): the first agent message
   * assigns the room, moves `new` → `in_progress` and stamps `claimed_at` /
   * `first_response_at` in the same transaction that assigns `seq`. Reuse one
   * `client_message_id` across retries so a retry replays instead of claiming
   * twice.
   */
  publicChatSend(slug: string, roomId: string, input: PublicChatAgentSendInput) {
    // `room` rides along because the auto-claim may have just changed status,
    // assignee, claimed_at and first_response_at in the same transaction —
    // the caller should apply it rather than re-fetching the row.
    return this.api.request<{ message: PublicChatStaffMessage; room: PublicChatStaffRoom }>(
      `/api/v1/public-chat/rooms/${roomId}/messages`,
      { method: 'POST', workspaceSlug: slug, body: input },
    );
  }

  /** API-224 — status and/or assignment; 422 PCHAT_INVALID_TRANSITION. */
  publicChatUpdateRoom(slug: string, roomId: string, patch: PublicChatRoomPatch) {
    return this.api.request<{ room: PublicChatStaffRoom }>(`/api/v1/public-chat/rooms/${roomId}`, {
      method: 'PATCH',
      workspaceSlug: slug,
      body: patch,
    });
  }

  /** API-225 — `uploader_id` = the agent AND `public_chat_room_id` = the room. */
  publicChatCreateUpload(slug: string, roomId: string, input: PublicChatUploadInput) {
    return this.api.request<UploadTicket>(`/api/v1/public-chat/rooms/${roomId}/uploads`, {
      method: 'POST',
      workspaceSlug: slug,
      body: input,
    });
  }

  /**
   * API-226 — soft delete, audited. Any active workspace member may delete any
   * message in the room, visitor rows included: this context has its own
   * endpoint precisely because `MessageEditor`'s moderator branch cannot
   * authorise deleting a NULL-sender row (MANDATORY fix 27).
   */
  publicChatDeleteMessage(slug: string, messageId: string) {
    // Answers 200 with the TOMBSTONE row, not 204: `PublicChatMessage` has no
    // SoftDeletes trait, so the row stays in the transcript (deleting it would
    // renumber the customer's `seq`) and the response is what to render in its
    // place. NOTE: §8.10 still documents 204 — see the reconciliation report.
    return this.api.request<{ message: PublicChatStaffMessage }>(`/api/v1/public-chat/messages/${messageId}`, {
      method: 'DELETE',
      workspaceSlug: slug,
    });
  }

  /**
   * API-227 — the counters are nested under `summary`, with `feature_enabled`
   * beside them. The rail badge is `summary.new + summary.problem`
   * (FR-PCHAT-003); `feature_enabled` is what lets the rail show a "paused"
   * chip instead of vanishing when the kill switch is off (FR-PCHAT-034).
   */
  publicChatSummary(slug: string) {
    return this.api.request<PublicChatSummaryResponse>('/api/v1/public-chat/summary', { workspaceSlug: slug });
  }

  /**
   * EVT-085 staff side — POST /public-chat/rooms/{id}/typing. The agent-tier
   * twin of `publicChatVisitorTyping`: it fans out to BOTH room channels, so
   * the customer sees "support is typing" (sender_kind only, no username) while
   * other agents additionally see WHICH colleague is typing. Answers 202
   * `{ok:true}`.
   */
  publicChatTyping(slug: string, roomId: string, typing: boolean) {
    return this.api.request<{ ok: boolean }>(`/api/v1/public-chat/rooms/${roomId}/typing`, {
      method: 'POST',
      workspaceSlug: slug,
      body: { typing },
    });
  }

  /** API-228 — per-agent read pointer (FR-PCHAT-010). Monotonic: a lower seq is a no-op. */
  publicChatMarkRead(slug: string, roomId: string, seq: number) {
    return this.api.request<PublicChatReadState>(`/api/v1/public-chat/rooms/${roomId}/read`, {
      method: 'POST',
      workspaceSlug: slug,
      body: { seq },
    });
  }
}
