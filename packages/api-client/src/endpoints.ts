import type {
  Message,
  MessagePage,
  ReadStatusEntry,
  RoomListItem,
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

  // -- messages (API-040/041) --

  messages(roomId: string, slug: string, params: { before_seq?: number; after_seq?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.before_seq !== undefined) query.set('before_seq', String(params.before_seq));
    if (params.after_seq !== undefined) query.set('after_seq', String(params.after_seq));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.api.request<MessagePage>(`/api/v1/rooms/${roomId}/messages${qs !== '' ? `?${qs}` : ''}`, { workspaceSlug: slug });
  }

  sendMessage(roomId: string, slug: string, body: string, clientMessageId: string, replyToMessageId?: string) {
    return this.api.request<{ message: Message }>(`/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      body: { client_message_id: clientMessageId, body, reply_to_message_id: replyToMessageId },
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
}
