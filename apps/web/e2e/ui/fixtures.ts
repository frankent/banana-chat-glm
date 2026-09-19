import { expect, type Page, type WebSocketRoute } from '@playwright/test';
import type { Message, RoomListItem } from '@banana-chat/shared';

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

export async function installChatFixture(page: Page) {
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
    if (path === '/me') return respond({ user: { ...me, locale: 'th' }, settings: { locale: 'th', timezone: 'Asia/Bangkok', notification: null } });
    if (path === '/me/workspaces') return respond([{ workspace: { id: 'ui-workspace', slug: 'ui-studio', name: 'Banana Studio', status: 'active' }, role: 'member', unread_rooms_count: 2, total_unread: 128 }]);
    if (path === '/rooms') {
      if (roomsFail) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic offline response' } } });
      return respond(url.searchParams.get('filter') === 'unread' ? rooms.filter(r => r.unread_count > 0) : rooms);
    }
    if (/^\/rooms\/[^/]+$/.test(path)) { const match = rooms.find(r => r.room.id === path.split('/')[2]) ?? rooms[0]; return respond({ ...match, members: [me, peer] }); }
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const input = request.postDataJSON();
      return respond({ message: { ...message(41, input.body), room_id: path.split('/')[2], sender_id: me.id, sender: me, client_message_id: input.client_message_id } });
    }
    if (path.endsWith('/messages')) {
      const before = Number(url.searchParams.get('before_seq') ?? 0);
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      if (before) { olderRequests++; if (olderGate) await olderGate; }
      const messages = before ? allMessages.filter(m => m.seq < before) : after ? allMessages.filter(m => m.seq > after) : allMessages.slice(20);
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
