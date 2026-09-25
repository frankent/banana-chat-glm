import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { ForwardMessagesResponse, Message, RoomListItem } from '@banana-chat/shared';

export const me = { id: 'ui-me', username: 'ui-tester', display_name: 'Alex Morgan', avatar_attachment_id: null };
const peer = { id: 'ui-peer', username: 'ui-peer', display_name: 'มินตรา Chen', avatar_attachment_id: null };
export function message(seq: number, body?: string): Message {
  const sender = seq % 4 === 0 ? me : peer;
  return {
    id: `ui-message-${seq}`, room_id: 'ui-design', workspace_id: 'ui-workspace', sender_id: sender.id, sender,
    type: 'text', body: body ?? (seq % 4 === 0 ? 'Looks good! Let’s keep it simple ✨' : `ข้อความ ${seq} — ปรับหน้าแชทให้อ่านง่าย มีพื้นที่ว่าง และใช้งานสะดวกบนมือถือ`),
    seq, client_message_id: null, reply_to: seq === 39 ? { id: 'ui-message-34', seq: 34, sender_id: peer.id, snippet: 'Review the spacing together', deleted: false } : null,
    system_event: null, edited_at: null, edit_count: 0, deleted_at: null, delete_reason: null,
    created_at: new Date(Date.UTC(2026, 8, 18, 9, seq)).toISOString(), mentions: [], attachments: [],
  };
}
const allMessages = Array.from({ length: 40 }, (_, index) => message(index + 1));
const room = { id: 'ui-design', workspace_id: 'ui-workspace', type: 'group' as const, name: 'Design studio · ออกแบบ', description: null, avatar_attachment_id: null, created_by: me.id, last_seq: 40, member_count: 8, last_message_at: allMessages[39].created_at };
const rooms: RoomListItem[] = [
  { room, my_role: 'member', other_user: null, last_message: allMessages[39], unread_count: 3, muted: false },
  { room: { ...room, id: 'ui-direct', type: 'dm', name: null, member_count: 2 }, my_role: 'member', other_user: peer, last_message: allMessages[38], unread_count: 0, muted: true },
  { room: { ...room, id: 'ui-product', name: 'Product team / ทีมพัฒนาผลิตภัณฑ์ที่มีชื่อยาว' }, my_role: 'member', other_user: null, last_message: { ...allMessages[37], body: 'https://example.test/' + 'long-path-'.repeat(20) }, unread_count: 125, muted: false },
];

export interface ForwardRequest {
  client_forward_id: string;
  source_room_id: string;
  message_ids: string[];
  room_ids: string[];
}
export type ForwardFailure = { status: 422; reason: string } | { status: 403 | 404 | 429 };
const originalAuthor = { sender_id: 'ui-original', display_name: 'Original Author', message_id: 'original-message', room_id: 'original-room', created_at: '2026-09-01T10:00:00Z' };
const forwardedMessages: Message[] = allMessages.map(item => {
  if (item.seq === 33) return { ...item, type: 'system', body: null, system_event: { event: 'room.created' }, forwarded_from: originalAuthor };
  if (item.seq === 34) return { ...item, id: 'optimistic-forward-fixture', body: 'Still sending' };
  if (item.seq === 35 || item.seq === 36) return { ...item, body: 'An original idea worth sharing', forwarded_from: originalAuthor };
  if (item.seq === 37) return { ...item, body: null, forwarded_from: originalAuthor, deleted_at: '2026-09-19T10:00:00Z' };
  if (item.seq === 38) return { ...item, forwarded_from: { ...originalAuthor, display_name: null } };
  return item;
});

const aiConversation = { id: 'ui-ai', title: 'AI composer layout', title_source: 'auto' as const, message_count: 0, last_message_at: null, archived_at: null, generating: false };

// aiConsented defaults to true so the 19 pre-existing tests are untouched; TC-UI-013
// flips it to assert the composer's consent-required label, which is the only way to
// catch a regression back to a FIXED aria-label (a fixed one is still non-empty).
export async function installChatFixture(page: Page, opts: { aiConsented?: boolean; aiConfigured?: boolean; aiAllowedInWorkspace?: boolean; systemAdmin?: boolean; aiStatusDelayMs?: number; forwarding?: boolean; roomRole?: RoomListItem['my_role'] } = {}) {
  // Forward fixtures are opt-in: established layout/read tests rely on 3 rooms and seq 39/40.
  const fixtureRooms: RoomListItem[] = opts.forwarding ? [...rooms,
    { ...rooms[0], room: { ...room, id: 'ui-secret', name: 'Secret project', is_secret: true, secret_expires_at: '2099-01-01T00:00:00Z' }, unread_count: 0 },
    ...Array.from({ length: 8 }, (_, index) => ({ ...rooms[0], room: { ...room, id: `ui-extra-${index + 1}`, name: `Forward room ${index + 1}` }, unread_count: 0 })),
  ] : rooms;
  const fixtureMessages = opts.forwarding ? forwardedMessages : allMessages;
  const forwardRequests: ForwardRequest[] = [];
  const forwardedCopies = new Map<string, Message>();
  let forwardFailure: ForwardFailure | null = null;
  let failedForwardRooms: string[] = [];
  let loseForwardResponse = false;
  let roomRequests = 0;
  let roomsFail = false;
  let olderRequests = 0;
  const reads: Array<{ roomId: string; seq: number }> = [];
  let olderGate: Promise<void> | null = null;
  let releaseOlder: (() => void) | undefined;
  const sockets = new Set<WebSocketRoute>();
  const channels = new Set<string>();
  await page.addInitScript(() => localStorage.setItem('orgchat.refresh', 'synthetic-ui-token'));
  await page.routeWebSocket(/\/app\//, socket => {
    sockets.add(socket);
    socket.send(JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '123.456', activity_timeout: 120 }) }));
    socket.onMessage(raw => {
      const event = JSON.parse(String(raw));
      if (event.event === 'pusher:subscribe') {
        channels.add(event.data.channel);
        socket.send(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: event.data.channel, data: '{}' }));
      }
      if (event.event === 'pusher:ping') socket.send(JSON.stringify({ event: 'pusher:pong', data: '{}' }));
    });
    socket.onClose(() => sockets.delete(socket));
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const respond = (data: unknown) => route.fulfill({ json: { data } });
    if (path === '/broadcasting/auth') return route.fulfill({ json: { auth: 'synthetic:signature' } });
    if (path === '/auth/refresh') return respond({ access_token: 'synthetic-access', refresh_token: 'synthetic-ui-token' });
    if (path === '/me') return respond({ user: { ...me, locale: 'th', is_system_admin: opts.systemAdmin ?? false }, settings: { locale: 'th', timezone: 'Asia/Bangkok', notification: null } });
    if (path === '/me/workspaces') return respond([{ workspace: { id: 'ui-workspace', slug: 'ui-studio', name: 'Banana Studio', status: 'active' }, role: 'member', unread_rooms_count: 2, total_unread: 128 }]);
    if (path === '/rooms') {
      roomRequests++;
      if (roomsFail) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic offline response' } } });
      return respond(url.searchParams.get('filter') === 'unread' ? fixtureRooms.filter(r => r.unread_count > 0) : fixtureRooms);
    }
    if (/^\/rooms\/[^/]+$/.test(path)) { const match = fixtureRooms.find(r => r.room.id === path.split('/')[2]) ?? rooms[0]; return respond({ ...match, my_role: opts.roomRole ?? match.my_role, members: [me, peer] }); }
    // AI (DEC-078) — declared BEFORE the generic /messages handlers below, which
    // would otherwise answer /ai/conversations/:id/messages with room messages.
    if (path === '/ai/status') {
      // Mocks answer instantly, which hides every "while status is unknown" defect.
      // TC-UI-014 uses this to hold the window open long enough to look at it.
      if (opts.aiStatusDelayMs !== undefined) await new Promise(r => setTimeout(r, opts.aiStatusDelayMs));
      return respond({
        enabled: true, configured: opts.aiConfigured ?? true, allowed_in_workspace: opts.aiAllowedInWorkspace ?? true,
        provider: (opts.aiConfigured ?? true) ? { name: 'mock', model: 'mock-1', window_size: 8000 } : null,
        limits: { daily_messages: 200, max_message_chars: 32000 },
        usage_today: { date: '2026-09-23', messages: 0, tokens_in: 0, tokens_out: 0, failed: 0 },
        memory_enabled: false, consented: opts.aiConsented ?? true,
      });
    }
    // Mirror AiGate: with no default provider every gated AI route is 503, which is
    // what makes the fixture a real test of the UI rather than of the fixture.
    if ((opts.aiConfigured ?? true) === false && path.startsWith('/ai/') && path !== '/ai/status') {
      return route.fulfill({ status: 503, json: { error: { code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'No default AI provider' } } });
    }
    if (path === '/ai/conversations' && request.method() === 'GET') return respond({ conversations: [aiConversation], next_cursor: null });
    if (/^\/ai\/conversations\/[^/]+$/.test(path)) return respond({ conversation: aiConversation });
    if (/^\/ai\/conversations\/[^/]+\/messages$/.test(path) && request.method() === 'GET') {
      return respond({ messages: [], has_more_before: false, oldest_seq: null, summary_up_to_seq: 0 });
    }
    // API-047 must precede the unmatched mutation catch-all. Persist synthetic copies
    // by idempotency key so retries prove the request cannot duplicate destinations.
    if (path === '/messages/forward' && request.method() === 'POST') {
      const input = request.postDataJSON() as ForwardRequest;
      forwardRequests.push(input);
      if (forwardFailure) {
        const failure = forwardFailure;
        return route.fulfill({ status: failure.status, json: { error: {
          code: failure.status === 422 ? 'MSG_FORWARD_INVALID' : failure.status === 403 ? 'ROOM_NOT_MEMBER' : failure.status === 429 ? 'RATE_LIMITED' : 'NOT_FOUND',
          message: 'Synthetic forwarding error', ...('reason' in failure ? { details: { reason: failure.reason } } : {}),
        } } });
      }
      let created = false;
      const response: ForwardMessagesResponse = { results: [], failed_room_ids: input.room_ids.filter(id => failedForwardRooms.includes(id)) };
      for (const roomId of input.room_ids) {
        if (response.failed_room_ids.includes(roomId)) continue;
        const copies = input.message_ids.map(messageId => {
          const key = `${input.client_forward_id}:${messageId}:${roomId}`;
          const existing = forwardedCopies.get(key);
          if (existing) return existing;
          const source = fixtureMessages.find(item => item.id === messageId)!;
          const copy: Message = { ...source, id: `forwarded-${forwardedCopies.size + 1}`, room_id: roomId, seq: 41 + [...forwardedCopies.values()].filter(item => item.room_id === roomId).length,
            sender: me, sender_id: me.id, reply_to: null, client_message_id: key, created_at: new Date().toISOString(),
            forwarded_from: source.forwarded_from ?? { sender_id: source.sender_id, display_name: source.sender?.display_name ?? null, message_id: source.id, room_id: source.room_id, created_at: source.created_at } };
          forwardedCopies.set(key, copy);
          created = true;
          return copy;
        });
        response.results.push({ room_id: roomId, messages: copies });
      }
      // A lost response is ambiguous: the server may have committed all copies.
      if (loseForwardResponse) return route.abort('failed');
      return route.fulfill({ status: created ? 201 : 200, json: { data: response } });
    }
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const input = request.postDataJSON();
      return respond({ message: { ...message(41, input.body), room_id: path.split('/')[2], sender_id: me.id, sender: me, client_message_id: input.client_message_id } });
    }
    if (path.endsWith('/messages')) {
      const before = Number(url.searchParams.get('before_seq') ?? 0);
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      if (before) { olderRequests++; if (olderGate) await olderGate; }
      const roomMessages = [...fixtureMessages, ...[...forwardedCopies.values()].filter(item => item.room_id === path.split('/')[2])];
      const messages = before ? roomMessages.filter(m => m.seq < before) : after ? roomMessages.filter(m => m.seq > after) : roomMessages.slice(20);
      return respond({ messages: messages.map(m => ({ ...m, room_id: path.split('/')[2] })), has_more_before: !before, has_more_after: false });
    }
    if (path.endsWith('/members') || path === '/members') return respond([me, peer]);
    if (path.endsWith('/read') && request.method() === 'POST') { const { seq } = request.postDataJSON(); reads.push({ roomId: path.split('/')[2], seq }); return respond({ last_read_seq: seq }); }
    if (path.endsWith('/read-status')) return respond({ read_by: [] });
    if (path.includes('public-chat') && path.endsWith('/summary')) return respond({ feature_enabled: false, summary: { new: 0, problem: 0 } });
    if (path.includes('notifications')) return respond({ notifications: [], unread_count: 0 });
    if (request.method() !== 'GET') return route.fulfill({ status: 204 });
    return respond([]);
  });
  return {
    forwardRequests,
    forwardedCopies,
    roomRequests: () => roomRequests,
    failForwardRooms: (ids: string[]) => { failedForwardRooms = ids; },
    failForward: (failure: ForwardFailure | null) => { forwardFailure = failure; },
    loseForwardResponse: (lose: boolean) => { loseForwardResponse = lose; },
    failRooms: () => { roomsFail = true; },
    olderRequests: () => olderRequests,
    reads,
    holdOlder: () => { olderGate = new Promise<void>(resolve => { releaseOlder = resolve; }); },
    releaseOlder: () => { releaseOlder?.(); olderGate = null; },
    async emit(event: string, data: unknown, channel = 'private-room.ui-design') {
      await expect.poll(() => channels.has(channel)).toBe(true);
      for (const socket of sockets) socket.send(JSON.stringify({ event, channel, data: JSON.stringify({ workspace_id: 'ui-workspace', data }) }));
    },
  };
}

export async function openChat(page: Page) {
  await page.goto('/rooms/ui-design');
  await expect(page.locator('[data-seq="40"]')).toBeVisible();
  await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
  await page.getByTestId('message-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
}
