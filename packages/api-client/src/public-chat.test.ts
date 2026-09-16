import { describe, expect, it, vi } from 'vitest';
import type { PublicChatPublicMessage, PublicChatVisitorRoom } from '@banana-chat/shared';
import { ApiClient } from './client.js';
import { Endpoints } from './endpoints.js';
import { TokenManager } from './token-manager.js';

function harness(body: unknown = { data: {} }) {
  const tokens = new TokenManager('/api/v1/auth/refresh', {
    getRefreshToken: () => null,
    setRefreshToken: () => {},
  });
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  const api = new ApiClient('http://x', tokens, fetchImpl as unknown as typeof fetch);
  return { endpoints: new Endpoints(api), fetchImpl, tokens };
}

const call = (fetchImpl: ReturnType<typeof vi.fn>) => ({
  url: fetchImpl.mock.calls[0]![0] as string,
  init: fetchImpl.mock.calls[0]![1] as { method?: string; headers: Record<string, string>; body?: string },
});

const CODE = 'a'.repeat(64);
const ROOM = '01JBROOM000000000000000001';

describe('API-220 / FR-PCHAT-004 — every list filter is serialised server-side', () => {
  it('sends status as csv, the assignee token, q, needs_reply and the cursor', () => {
    const { endpoints, fetchImpl } = harness({ data: { rooms: [], next_cursor: null } });
    void endpoints.publicChatRooms('acme', {
      status: ['new', 'problem'],
      assigned: 'me',
      q: 'somchai',
      needs_reply: true,
      cursor: 'c1',
      limit: 25,
    });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(
      'http://x/api/v1/public-chat/rooms?status=new%2Cproblem&assigned=me&q=somchai&needs_reply=1&cursor=c1&limit=25',
    );
    expect(init.headers['X-Workspace-Id']).toBe('acme');
  });

  it('omits absent filters rather than serialising the literal string "undefined"', () => {
    const { endpoints, fetchImpl } = harness({ data: { rooms: [], next_cursor: null } });
    void endpoints.publicChatRooms('acme', { q: '', status: [], needs_reply: false });
    expect(call(fetchImpl).url).toBe('http://x/api/v1/public-chat/rooms');
  });
});

describe('API-210..216 / DEC-063 — the visitor tier addresses rooms by code and never by workspace', () => {
  it('puts the code in the path, never in a query string, and sends no X-Workspace-Id', () => {
    const { endpoints, fetchImpl } = harness({ data: { messages: [], last_seq: 0 } });
    void endpoints.publicChatVisitorMessages(CODE, { after_seq: 12 });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/${CODE}/messages?after_seq=12`);
    expect(url).not.toContain('code=');
    expect(init.headers['X-Workspace-Id']).toBeUndefined();
  });

  it('API-212 requires a caller-supplied client_message_id so a retry replays instead of duplicating', () => {
    const { endpoints, fetchImpl } = harness({ data: { message: {} } });
    void endpoints.publicChatVisitorSend(CODE, { client_message_id: 'uuid-1', body: 'hello' });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/${CODE}/messages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ client_message_id: 'uuid-1', body: 'hello' });
  });

  it('API-215 posts the exact channel name the server compares by string equality', () => {
    const { endpoints, fetchImpl } = harness({ auth: 'app-key:sig' });
    void endpoints.publicChatVisitorBroadcastAuth(CODE, '123.456', `private-public-chat.${ROOM}`);
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/${CODE}/broadcasting/auth`);
    expect(JSON.parse(init.body as string)).toEqual({
      socket_id: '123.456',
      channel_name: `private-public-chat.${ROOM}`,
    });
  });
});

describe('API-223..228 — the agent tier addresses rooms by ULID inside the workspace', () => {
  it('sends on API-223 with the workspace header', () => {
    const { endpoints, fetchImpl } = harness({ data: { message: {} } });
    void endpoints.publicChatSend('acme', ROOM, { client_message_id: 'uuid-2', body: 'on it' });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/rooms/${ROOM}/messages`);
    expect(init.headers['X-Workspace-Id']).toBe('acme');
  });

  it('PATCHes status and assignment on API-224, preserving an explicit null unassign', () => {
    const { endpoints, fetchImpl } = harness({ data: { room: {} } });
    void endpoints.publicChatUpdateRoom('acme', ROOM, { status: 'problem', assigned_to: null });
    const { init } = call(fetchImpl);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'problem', assigned_to: null });
  });

  it('API-226 deletes by MESSAGE id, not through the room path', () => {
    const { endpoints, fetchImpl } = harness({ data: null });
    void endpoints.publicChatDeleteMessage('acme', '01JBMSG0000000000000000001');
    const { url, init } = call(fetchImpl);
    expect(url).toBe('http://x/api/v1/public-chat/messages/01JBMSG0000000000000000001');
    expect(init.method).toBe('DELETE');
  });

  it('API-228 advances the per-agent read pointer', () => {
    const { endpoints, fetchImpl } = harness({ data: { last_read_seq: 9, unread_count: 0 } });
    void endpoints.publicChatMarkRead('acme', ROOM, 9);
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/rooms/${ROOM}/read`);
    expect(JSON.parse(init.body as string)).toEqual({ seq: 9 });
  });
});

// ===========================================================================
// FR-PCHAT — CONTRACT RECONCILIATION. Each case below pins one shape that the
// API actually returns, so a future edit to `types.ts` that re-invents a field
// the server does not send fails at COMPILE time rather than as an undefined
// at runtime on a customer-facing page.
// ===========================================================================

describe('EVT-085 staff side — the agent typing route has a client method', () => {
  it('POSTs to the ROOM path with the workspace header, not the visitor code path', () => {
    const { endpoints, fetchImpl } = harness({ ok: true });
    void endpoints.publicChatTyping('acme', ROOM, true);
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`http://x/api/v1/public-chat/rooms/${ROOM}/typing`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Workspace-Id']).toBe('acme');
    expect(JSON.parse(init.body as string)).toEqual({ typing: true });
  });
});

describe('API-227 — the counters are nested under `summary`', () => {
  it('reads new/problem for the rail badge from the nested object, beside feature_enabled', async () => {
    const { endpoints } = harness({
      summary: { new: 2, in_progress: 1, problem: 3, done: 7, mine: 1, needs_reply: 4 },
      feature_enabled: false,
    });
    const body = await endpoints.publicChatSummary('acme');
    // The badge is summary.new + summary.problem — NOT body.new, which is the
    // exact mistake a flat `PublicChatSummary` return type invited.
    expect(body.summary.new + body.summary.problem).toBe(5);
    expect(body.feature_enabled).toBe(false);
  });
});

describe('API-213 — the public-chat upload ticket is NOT the API-060 ticket', () => {
  it('carries attachment.id + upload_url, with no `headers`/`expires_at` to read', async () => {
    const { endpoints } = harness({ attachment: { id: 'att_1', status: 'pending' }, upload_url: 'http://put' });
    const ticket = await endpoints.publicChatVisitorUpload(CODE, {
      kind: 'image',
      filename: 'a.png',
      mime_type: 'image/png',
      size_bytes: 10,
    });
    expect(ticket.attachment.id).toBe('att_1');
    expect(ticket.upload_url).toBe('http://put');
    // @ts-expect-error API-060's `put_url` does not exist on this tier's ticket.
    void ticket.put_url;
  });
});

describe('FR-PCHAT-014 — the visitor wire shapes cannot name an internal field', () => {
  it('has no raw status, no assignee, no meta and no workspace id on the room', () => {
    const room: PublicChatVisitorRoom = {
      id: ROOM,
      customer_name: 'Somsri',
      provider_name: 'Acme Insurance',
      status_public: 'open',
      locale: 'th',
      created_at: '2026-01-01T00:00:00+00:00',
      expires_at: null,
      last_seq: 3,
    };
    expect(room.status_public).toBe('open');

    // Each of these is a field the STAFF room carries and the customer surface
    // must never gain. A `@ts-expect-error` that stops erroring — because
    // someone added the field — fails this test loudly.
    // @ts-expect-error the raw status (`problem` included) is internal triage.
    void room.status;
    // @ts-expect-error who is assigned, and that anyone is, is internal.
    void room.assigned_to;
    // @ts-expect-error the partner's arbitrary payload is never served to the visitor.
    void room.meta;
    // @ts-expect-error tenancy is not the customer's business.
    void room.workspace_id;
    // @ts-expect-error the customer's own credential is not echoed back to them.
    void room.code;
  });

  it('labels a message with `display_name` only — never a user id or a snapshot', () => {
    const message: PublicChatPublicMessage = {
      id: '01JBMSG0000000000000000001',
      seq: 1,
      sender_kind: 'agent',
      // Assembled server-side from write-time snapshots: "provider (username)".
      display_name: 'Acme Insurance (suda.k)',
      type: 'text',
      body: 'we are on it',
      reply_to: null,
      system_event: null,
      system_meta: null,
      attachments: [],
      deleted: false,
      created_at: '2026-01-01T00:00:00+00:00',
    };
    expect(message.display_name).toBe('Acme Insurance (suda.k)');

    // @ts-expect-error no member ULID reaches the customer surface.
    void message.sender;
    // @ts-expect-error nor does the raw snapshot column it was built from.
    void message.agent_username_snapshot;
    // @ts-expect-error mentions are an internal-rooms concept and do not exist here.
    void message.mentions;
    // @ts-expect-error the public tombstone is a flag; the audit pair is staff-only.
    void message.deleted_by;
  });

  it('projects system_meta to public statuses with no actor_username', () => {
    const meta: NonNullable<PublicChatPublicMessage['system_meta']> = { from: 'open', to: 'closed' };
    expect(meta.to).toBe('closed');
    // @ts-expect-error `problem` is projected to `closed`/`open` before it ships.
    const raw: NonNullable<PublicChatPublicMessage['system_meta']> = { to: 'problem' };
    void raw;
    // @ts-expect-error the acting agent's username is dropped by the projection.
    void meta.actor_username;
  });
});
