import type {
  AiConversationSummary,
  AiMemory,
  AiMemoryCategory,
  AiMessage,
  AiMessagePage,
  AiSendResponse,
  AiStatus,
  Attachment,
  Message,
  MessagePage,
  ReadStatusEntry,
  RoomListItem,
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
    return this.api.request<{ user: UserStub & { locale: string } }>('/api/v1/me');
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

  messages(roomId: string, slug: string, params: { before_seq?: number; after_seq?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.before_seq !== undefined) query.set('before_seq', String(params.before_seq));
    if (params.after_seq !== undefined) query.set('after_seq', String(params.after_seq));
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

  completeUpload(attachmentId: string, slug: string) {
    return this.api.request<{ attachment: Attachment }>(`/api/v1/uploads/${attachmentId}/complete`, {
      method: 'POST',
      workspaceSlug: slug,
    });
  }

  attachment(attachmentId: string, slug: string) {
    return this.api.request<{ attachment: Attachment }>(`/api/v1/attachments/${attachmentId}`, {
      workspaceSlug: slug,
    });
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
