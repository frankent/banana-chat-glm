import { request, expect } from '@playwright/test';
import { test } from './fixtures';

/**
 * Backend regression — REST layer against the docker api (:8000).
 * Auth endpoints are bare JSON (§7); workspace endpoints wrap in {data}.
 */

const API = 'http://localhost:8000/api/v1';
const stamp = Date.now().toString(36);

interface Ctx {
  token: string;
  ctx: Awaited<ReturnType<typeof request.newContext>>;
  roomId: string;
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status, `login ${username}`).toBe(200);
  const body = await res.json();
  expect(typeof body.access_token).toBe('string');
  return body.access_token;
}

test.beforeAll(async () => {
  const token = await login('tony', 'Tony12345!');
  const ctx = await request.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': 'acme' },
  });
  const rooms = await ctx.get(`${API}/rooms`);
  expect(rooms.status()).toBe(200);
  const list = (await rooms.json()).data as Array<{ room: { id: string; name: string } }>;
  const engineering = list.find((r) => r.room.name === 'Engineering');
  expect(engineering, 'seeded Engineering room exists').toBeDefined();
  (test as unknown as { _ctx: Ctx })._ctx = { token, ctx, roomId: engineering!.room.id };
});

function api(): Ctx {
  return (test as unknown as { _ctx: Ctx })._ctx;
}

test('health — all subsystems ok', async ({ request: pw }) => {
  const res = await pw.get(`${API}/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('healthy');
  for (const [name, value] of Object.entries(body.checks)) {
    expect(String(value).startsWith('ok'), `${name} = ${value}`).toBeTruthy();
  }
});

test('API-041 history — Engineering room has seeded messages', async () => {
  const res = await api().ctx.get(`${API}/rooms/${api().roomId}/messages?limit=20`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data.messages)).toBeTruthy();
  expect(body.data.messages.length).toBeGreaterThan(0);
  // ascending seq order
  const seqs = body.data.messages.map((m: { seq: number }) => m.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    expect(seqs[i], 'seq strictly increasing').toBeGreaterThan(seqs[i - 1]);
  }
});

test('API-040 send → 201, then idempotent replay → 200 same id', async () => {
  const cmid = crypto.randomUUID();
  const text = `pw-api ${stamp}`;

  const created = await api().ctx.post(`${API}/rooms/${api().roomId}/messages`, {
    data: { body: text, client_message_id: cmid },
  });
  expect(created.status()).toBe(201);
  const message = (await created.json()).data.message;
  expect(message.body).toBe(text);
  expect(message.client_message_id).toBe(cmid);

  const replay = await api().ctx.post(`${API}/rooms/${api().roomId}/messages`, {
    data: { body: text, client_message_id: cmid },
  });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).data.message.id).toBe(message.id);
});

test('API-040 validation — uuid client_message_id required', async () => {
  const res = await api().ctx.post(`${API}/rooms/${api().roomId}/messages`, {
    data: { body: 'x', client_message_id: 'not-a-uuid' },
  });
  expect(res.status()).toBe(422);
});

test('API-080 search — finds the message just sent', async () => {
  const res = await api().ctx.get(`${API}/search/messages?q=pw-api%20${stamp}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.results.length).toBeGreaterThanOrEqual(1);
});

test('API-073 notifications — list responds', async () => {
  const res = await api().ctx.get(`${API}/me/notifications?limit=5`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.data.notifications)).toBeTruthy();
});

test('auth — wrong password rejected 401 (no leak)', async ({ request: pw }) => {
  const res = await pw.post(`${API}/auth/login`, {
    data: { username: 'tony', password: 'WrongPassword1!' },
  });
  expect(res.status()).toBe(401);
});

test('workspace header required — 400 without X-Workspace-Id', async ({ request: pw }) => {
  const res = await pw.get(`${API}/rooms`, {
    headers: { Authorization: `Bearer ${api().token}` },
  });
  expect(res.status()).toBe(400);
});
