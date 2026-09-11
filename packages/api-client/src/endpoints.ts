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
  AiStatus,
  Attachment,
  FileSearchResult,
  InAppNotification,
  Message,
  MessagePage,
  MessageSearchResult,
  ReadStatusEntry,
  RoomListItem,
  SearchPage,
  UploadTicket,
  UserStub,
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

  // -- workspace (API-011..014) --

  directory(q = '', slug: string) {
    return this.api.request<UserStub[]>(`/api/v1/members?q=${encodeURIComponent(q)}`, { workspaceSlug: slug });
  }

  // -- rooms (API-020..039) --

  rooms(slug: string, filter?: 'all' | 'unread' | 'hidden') {
    const query = filter !== undefined ? `?filter=${filter}` : '';
    return this.api.request<RoomListItem[]>(`/api/v1/rooms${query}`, { workspaceSlug: slug });
  }

  createDm(userId: string, slug: string) {
    return this.api.request<RoomDetail>('/api/v1/rooms', {
      method: 'POST',
      body: { type: 'dm', user_id: userId },
      workspaceSlug: slug,
    });
  }

  createGroup(name: string, memberIds: string[], slug: string, description?: string) {
    return this.api.request<RoomDetail>('/api/v1/rooms', {
      method: 'POST',
      body: { type: 'group', name, member_ids: memberIds, description },
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
}
