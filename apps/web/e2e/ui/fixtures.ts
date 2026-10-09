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
export async function installChatFixture(page: Page, opts: { aiConsented?: boolean; aiConfigured?: boolean; aiAllowedInWorkspace?: boolean; systemAdmin?: boolean; aiStatusDelayMs?: number; forwarding?: boolean; roomRole?: RoomListItem['my_role']; locale?: 'th' | 'en'; uploads?: boolean } = {}) {
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
  const reactionState = new Map<string, Map<string, Map<string, string>>>();
  const reactionCountOverrides = new Map<string, Array<{ emoji: string; count: number }>>();
  let reactionLimitFailure = false;
  const reactionRequests: Array<{ method: string; messageId: string; emoji?: string }> = [];
  // FR-MEDIA-001 — opt-in (`uploads: true`) mock of the whole upload pipeline, so a staged chip can
  // really reach `ready` and a test can read back exactly what the page asked for and sent.
  const uploadRequests: Array<{ kind: string; filename: string; mime_type: string; size_bytes: number }> = [];
  const storagePuts: Array<{ attachmentId: string; bytes: number }> = [];
  const completeRequests: string[] = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  if (opts.uploads) {
    await page.route('**/__ui-storage/**', async route => {
      const attachmentId = new URL(route.request().url()).pathname.split('/').pop() ?? '';
      storagePuts.push({ attachmentId, bytes: route.request().postDataBuffer()?.length ?? 0 });
      await route.fulfill({ status: 200, headers: { ETag: '"ui-etag"', 'Access-Control-Expose-Headers': 'ETag' }, body: '' });
    });
  }
  let reactionPutGate: Promise<void> | null = null;
  let releaseReactionPut: (() => void) | undefined;
  const reactionMembers = [me, peer];
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
    const reactionMatch = path.match(/^\/rooms\/[^/]+\/messages\/([^/]+)\/reactions$/);
    if (reactionMatch) {
      const messageId = reactionMatch[1]!;
      let byEmoji = reactionState.get(messageId);
      if (!byEmoji) { byEmoji = new Map(); reactionState.set(messageId, byEmoji); }
      const snapshot = () => ({ message_id: messageId, reactions: [...byEmoji!.entries()].map(([emoji, users]) => ({ emoji, count: users.size })), my_reaction: [...byEmoji!.entries()].find(([, users]) => users.has(me.id))?.[0] ?? null });
      if (request.method() === 'PUT') {
        const emoji = (request.postDataJSON() as { emoji: string }).emoji;
        reactionRequests.push({ method: 'PUT', messageId, emoji });
        if (reactionPutGate) await reactionPutGate;
        if (reactionLimitFailure) { reactionLimitFailure = false; return route.fulfill({ status: 422, json: { error: { code: 'REACTION_LIMIT', message: 'Synthetic reaction limit' } } }); }
        for (const [oldEmoji, users] of byEmoji) { users.delete(me.id); if (!users.size) byEmoji.delete(oldEmoji); }
        if (!byEmoji.has(emoji) && byEmoji.size >= 20) return route.fulfill({ status: 422, json: { error: { code: 'REACTION_LIMIT', message: 'Synthetic reaction limit' } } });
        if (!byEmoji.has(emoji)) byEmoji.set(emoji, new Map());
        byEmoji.get(emoji)!.set(me.id, emoji);
        return respond(snapshot());
      }
      if (request.method() === 'DELETE') {
        reactionRequests.push({ method: 'DELETE', messageId });
        for (const [emoji, users] of byEmoji) { users.delete(me.id); if (!users.size) byEmoji.delete(emoji); }
        return respond(snapshot());
      }
      reactionRequests.push({ method: 'GET', messageId });
      const users = [...byEmoji.entries()].map(([emoji, members]) => ({ emoji, count: members.size, users: [...members.keys()].map(id => reactionMembers.find(member => member.id === id) ?? { id, username: id, display_name: id, avatar_attachment_id: null }) }));
      for (const override of reactionCountOverrides.get(messageId) ?? []) {
        const found = users.find(item => item.emoji === override.emoji);
        if (found) found.count = override.count;
        else users.push({ ...override, users: [] });
      }
      return respond({ message_id: messageId, reactions: users });
    }
    if (path === '/broadcasting/auth') return route.fulfill({ json: { auth: 'synthetic:signature' } });
    if (path === '/auth/refresh') return respond({ access_token: 'synthetic-access', refresh_token: 'synthetic-ui-token' });
    if (path === '/me') return respond({ user: { ...me, locale: opts.locale ?? 'th', is_system_admin: opts.systemAdmin ?? false }, settings: { locale: opts.locale ?? 'th', timezone: 'Asia/Bangkok', notification: null } });
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
    if (opts.uploads && path === '/uploads' && request.method() === 'POST') {
      const input = request.postDataJSON() as { kind: string; filename: string; mime_type: string; size_bytes: number };
      uploadRequests.push(input);
      const attachmentId = `ui-att-${uploadRequests.length}`;
      return respond({ attachment_id: attachmentId, put_url: `${url.origin}/__ui-storage/${attachmentId}`, headers: { 'Content-Type': input.mime_type }, expires_at: '2099-01-01T00:00:00Z' });
    }
    const completeMatch = path.match(/^\/uploads\/([^/]+)\/complete$/);
    if (opts.uploads && completeMatch && request.method() === 'POST') {
      const attachmentId = completeMatch[1]!;
      completeRequests.push(attachmentId);
      const upload = uploadRequests[Number(attachmentId.replace('ui-att-', '')) - 1]!;
      return respond({ attachment: { id: attachmentId, kind: upload.kind, status: 'ready', original_name: upload.filename, mime_type: upload.mime_type, size_bytes: upload.size_bytes, width: null, height: null, duration_ms: null, urls: { original: null, thumb_sm: null, thumb_md: null, poster: null }, urls_expire_at: '2099-01-01T00:00:00Z' } });
    }
    if (path.endsWith('/messages') && request.method() === 'POST') {
      const input = request.postDataJSON();
      sentMessages.push(input);
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
    uploadRequests,
    storagePuts,
    completeRequests,
    sentMessages,
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
    reactionRequests,
    failNextReactionLimit: () => { reactionLimitFailure = true; },
    holdReactionPut: () => { reactionPutGate = new Promise<void>(resolve => { releaseReactionPut = resolve; }); },
    releaseReactionPut: () => { releaseReactionPut?.(); reactionPutGate = null; },
    setReactionCountOverride: (messageId: string, counts: Array<{ emoji: string; count: number }>) => { reactionCountOverrides.set(messageId, counts); },
    seedReaction: (messageId: string, emoji: string, user = peer.id) => {
      let byEmoji = reactionState.get(messageId); if (!byEmoji) { byEmoji = new Map(); reactionState.set(messageId, byEmoji); }
      let users = byEmoji.get(emoji); if (!users) { users = new Map(); byEmoji.set(emoji, users); }
      users.set(user, emoji);
    },
  };
}

export async function openChat(page: Page) {
  await page.goto('/rooms/ui-design');
  await expect(page.locator('[data-seq="40"]')).toBeVisible();
  await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
  await page.getByTestId('message-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
}

// ---------------------------------------------------------------------------------------------
// FR-KAN-007 / FR-MSG-013 — ticket share, link cards, external preview. Layered ON TOP of
// installChatFixture: Playwright runs the newest page.route first, and `route.fallback()` hands
// anything not handled here to the base fixture (whose catch-all answers 204 to every non-GET,
// so no write can ever leave the page). Everything that is not the Vite origin is blocked.
// ---------------------------------------------------------------------------------------------
export const T_ORIGIN = 'http://127.0.0.1:5180';
/** Real ticket ids are LOWERCASE ULIDs (HasUlid::strtolower). The mock compares case-SENSITIVELY, like Postgres. */
export const TICKET_A = '01hx5k8m3p9q2r7s4t6v1w0yza';
export const TICKET_B = '01hx5k8m3p9q2r7s4t6v1w0yzb';
export const TICKET_OTHER = '01hx5k8m3p9q2r7s4t6v1w0yzc';
export const TICKET_ARCHIVED = '01hx5k8m3p9q2r7s4t6v1w0yzd';
export const TICKET_MISSING = '01hx5k8m3p9q2r7s4t6v1w0yze';
export const MEET_LIVE = 'a'.repeat(64);
export const MEET_ENDED = 'b'.repeat(64);
export const MEET_MISSING = 'c'.repeat(64);
export const MEET_503 = 'd'.repeat(64);
export const SECRET_TITLE = 'Quarterly payroll leak SECRET-TITLE-42';
export const workspaceList = [
  { workspace: { id: 'ui-workspace', slug: 'ui-studio', name: 'Banana Studio', status: 'active' }, role: 'member', unread_rooms_count: 2, total_unread: 128 },
  { workspace: { id: 'other-workspace', slug: 'other-team', name: 'Other Team', status: 'active' }, role: 'member', unread_rooms_count: 0, total_unread: 0 },
  { workspace: { id: 'arch-workspace', slug: 'old-team', name: 'Old Team', status: 'archived' }, role: 'member', unread_rooms_count: 0, total_unread: 0 },
];
interface MockTicket { id: string; wsId: string; number: number; title: string; lane: { id: string; name: string; color: string; is_done: boolean }; priority: 'low' | 'medium' | 'high' | 'urgent'; assignee: boolean; due_at: string | null }
const lane = (id: string, name: string, is_done = false) => ({ id, name, color: '#2563eb', is_done });
export const LANES = { todo: lane('lane-todo', 'To do'), doing: lane('lane-doing', 'Doing'), done: lane('lane-done', 'Done', true) };
export type LinkPreviewMock = { status: 'ready'; url: string; title: string | null; description: string | null; site_name: string | null; image_url: string | null; image_expires_at: string | null; fetched_at: string } | { status: 'pending' | 'none'; url: string };
export type CardsOptions = NonNullable<Parameters<typeof installChatFixture>[1]> & {
  /** seq -> partial message override (ui-design room); body is what the cards are made from. */
  messages?: Record<number, Partial<Message>>;
  /** workspace the viewer starts in (localStorage lastWorkspace) */
  startWorkspace?: 'ui-studio' | 'other-team' | 'old-team';
  anonymous?: boolean;
};
export async function installCardsFixture(page: Page, opts: CardsOptions = {}) {
  const blocked: string[] = [];
  // Lowest priority: anything that is not our Vite origin (or the harness ws) never leaves the machine.
  await page.route(u => new URL(u.toString()).origin !== T_ORIGIN && !/^wss?:/.test(u.protocol), route => { if (!/fonts\.(googleapis|gstatic)\.com/.test(route.request().url())) blocked.push(route.request().url()); return route.abort('blockedbyclient'); });
  const base = await installChatFixture(page, opts);
  if (opts.startWorkspace) await page.addInitScript(slug => localStorage.setItem('orgchat.lastWorkspace', slug), opts.startWorkspace);
  if (opts.anonymous) await page.addInitScript(() => localStorage.removeItem('orgchat.refresh'));
  const tickets = new Map<string, MockTicket>([
    [TICKET_A, { id: TICKET_A, wsId: 'ui-workspace', number: 7, title: SECRET_TITLE, lane: LANES.todo, priority: 'high', assignee: true, due_at: '2026-10-20T00:00:00Z' }],
    [TICKET_B, { id: TICKET_B, wsId: 'ui-workspace', number: 8, title: '<img src=x onerror="window.__xss=1"> second', lane: LANES.doing, priority: 'low', assignee: false, due_at: null }],
    [TICKET_OTHER, { id: TICKET_OTHER, wsId: 'other-workspace', number: 3, title: 'Other workspace ticket', lane: LANES.todo, priority: 'medium', assignee: true, due_at: null }],
    [TICKET_ARCHIVED, { id: TICKET_ARCHIVED, wsId: 'arch-workspace', number: 1, title: 'Archived ticket', lane: LANES.done, priority: 'low', assignee: false, due_at: null }],
  ]);
  const forbidden = new Set<string>();
  const cardRequests: Array<{ id: string; slug: string | undefined }> = [];
  const ticketDetailRequests: Array<{ id: string; slug: string | undefined }> = [];
  const previewRequests: string[] = [];
  const lobbyRequests: string[] = [];
  const sendRequests: Array<{ roomId: string; body: string; client_message_id: string; slug: string | undefined }> = [];
  const previews = new Map<string, LinkPreviewMock[]>();
  const state = { sendFailure: null as null | { status: number; code: string }, sendGate: null as null | Promise<void>, offline: false, previewsEnabled: true, openedLoginUsers: 0 };
  const bySlug = (slug: string | undefined) => workspaceList.find(w => w.workspace.slug === slug)?.workspace;
  const card = (t: MockTicket) => ({ id: t.id, workspace_id: t.wsId, number: t.number, title: t.title, type: 'task', priority: t.priority, due_at: t.due_at, version: 1, updated_at: '2026-10-10T00:00:00Z', assignee: t.assignee ? { id: 'ui-peer', display_name: 'มินตรา Chen' } : null, lane: t.lane });
  const detail = (t: MockTicket) => ({ ...card(t), description: null, lane_id: t.lane.id, assignee_id: t.assignee ? 'ui-peer' : null, reporter_id: me.id, assignee: t.assignee ? { id: 'ui-peer', username: 'ui-peer', display_name: 'มินตรา Chen' } : null, reporter: me, labels: [], attachments: [], comments: [], comments_cursor: null, history: [], created_at: '2026-10-01T00:00:00Z' });
  const msgs = () => Array.from({ length: 40 }, (_, i) => ({ ...message(i + 1), ...(opts.messages?.[i + 1] ?? {}) }));
  const err = (route: import('@playwright/test').Route, status: number, code: string) => route.fulfill({ status, json: { error: { code, message: `Synthetic ${code}` } } });

  await page.route('**/__ui-img/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const slug = request.headers()['x-workspace-id'];
    const json = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    if (path === '/auth/login' && request.method() === 'POST') {
      state.openedLoginUsers++;
      return json({ access_token: 'synthetic-access', refresh_token: 'synthetic-ui-token', user: { ...me, locale: 'th', is_system_admin: false, must_change_password: false }, workspaces: workspaceList });
    }
    if (path === '/me/workspaces') return json(workspaceList);
    if (path === '/board') return json({ lanes: Object.values(LANES).map((l, position) => ({ ...l, workspace_id: 'ui-workspace', position })), can_manage: false });
    if (path === '/board/tickets') return json({ tickets: [...tickets.values()].filter(t => t.wsId === bySlug(slug)?.id).map(t => ({ ...detail(t), lane_id: t.lane.id })), next_cursor: null });
    const cardMatch = path.match(/^\/board\/tickets\/([^/]+)\/card$/);
    if (cardMatch) {
      cardRequests.push({ id: process.env.LINK_MOCK_CI ? cardMatch[1]!.toLowerCase() : cardMatch[1]!, slug });
      if (state.offline) return route.abort('internetdisconnected');
      // DIAGNOSTIC ONLY: LINK_MOCK_CI=1 makes the mock case-insensitive to look past the uppercase-id defect.
      const t = tickets.get(process.env.LINK_MOCK_CI ? cardMatch[1]!.toLowerCase() : cardMatch[1]!);
      const ws = bySlug(slug);
      if (!ws) return err(route, 403, 'WS_FORBIDDEN');
      if (forbidden.has(cardMatch[1]!)) return err(route, 403, 'WS_FORBIDDEN');
      if (!t || t.wsId !== ws.id) return err(route, 404, 'NOT_FOUND');
      return route.fulfill({ status: 200, headers: { 'Cache-Control': 'no-store' }, json: { data: card(t) } });
    }
    const ticketMatch = path.match(/^\/board\/tickets\/([^/]+)$/);
    if (ticketMatch && request.method() === 'GET') {
      ticketDetailRequests.push({ id: ticketMatch[1]!, slug });
      const t = tickets.get(ticketMatch[1]!); const ws = bySlug(slug);
      if (!t || !ws || t.wsId !== ws.id) return err(route, 404, 'NOT_FOUND');
      return json(detail(t));
    }
    if (path === '/link-preview') {
      const target = url.searchParams.get('url') ?? '';
      previewRequests.push(target);
      if (!state.previewsEnabled) return json({ status: 'none', url: target });
      const queue = previews.get(target) ?? [{ status: 'none', url: target } as LinkPreviewMock];
      return json(queue.length > 1 ? queue.shift() : queue[0]);
    }
    const lobby = path.match(/^\/public-meetings\/([0-9a-f]{64})$/);
    if (lobby) {
      lobbyRequests.push(lobby[1]!);
      if (lobby[1] === MEET_ENDED) return err(route, 410, 'MEETING_ENDED');
      if (lobby[1] === MEET_MISSING) return err(route, 404, 'NOT_FOUND');
      if (lobby[1] === MEET_503) return err(route, 503, 'CALLS_DISABLED');
      return json({ title: 'Sprint planning <b>x</b>', expires_at: '2099-01-01T10:00:00Z', capacity: 12, identity: null });
    }
    if (/^\/rooms\/[^/]+\/messages$/.test(path) && request.method() === 'POST') {
      const input = request.postDataJSON() as { body: string; client_message_id: string };
      sendRequests.push({ roomId: path.split('/')[2]!, body: input.body, client_message_id: input.client_message_id, slug });
      if (state.sendGate) await state.sendGate;
      if (state.sendFailure) { const f = state.sendFailure; return err(route, f.status, f.code); }
      return route.fallback();
    }
    if (/^\/rooms\/ui-design\/messages$/.test(path) && request.method() === 'GET' && opts.messages) {
      const before = Number(url.searchParams.get('before_seq') ?? 0);
      const all = msgs();
      const list = before ? all.filter(m => m.seq < before) : all.slice(20);
      return route.fulfill({ json: { data: { messages: list, has_more_before: !before, has_more_after: false } } });
    }
    if (path === '/rooms' && request.method() === 'GET' && opts.messages) {
      const last = msgs()[39]!;
      return json(rooms.map((r, i) => i === 0 ? { ...r, last_message: last } : r));
    }
    return route.fallback();
  });
  return {
    ...base, blocked, cardRequests, ticketDetailRequests, previewRequests, lobbyRequests, sendRequests, tickets, forbidden,
    setPreviews: (u: string, queue: LinkPreviewMock[]) => { previews.set(u, queue); },
    failSend: (f: { status: number; code: string } | null) => { state.sendFailure = f; },
    holdSend: () => { let release!: () => void; state.sendGate = new Promise<void>(r => { release = r; }); return () => { release(); state.sendGate = null; }; },
    setOffline: (v: boolean) => { state.offline = v; },
    disablePreviews: () => { state.previewsEnabled = false; },
    logins: () => state.openedLoginUsers,
    moveTicket: (id: string, laneKey: keyof typeof LANES) => { tickets.get(id)!.lane = LANES[laneKey]; },
    async boardChanged() { await base.emit('board.changed', {}, 'private-workspace.ui-workspace'); },
    ticketUrl: (id: string, ws: string | null = 'ui-studio') => `${T_ORIGIN}/board/${id}${ws ? `?ws=${ws}` : ''}`,
  };
}
export const luminanceRatio = (a: string, b: string) => {
  const lum = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi! + 0.05) / (lo! + 0.05);
};
export async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}
