// Run from repository root: node docs/reviews/2026-09-11/reproduce.mjs
// Creates an owner-only demo room; soft-deletes it in finally. Requires dev stack.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const api = 'http://localhost:8000/api/v1';
const web = 'http://localhost:5173';
const findings = [];
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
let token, roomId;
async function request(path, method = 'GET', body) {
  const response = await fetch(api + path, { method, headers: {
    'Content-Type': 'application/json', Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}`, 'X-Workspace-Id': 'acme' } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = response.status === 204 ? {} : await response.json();
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after') ?? json.error?.details?.retry_after_seconds ?? 60);
    await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000));
    return request(path, method, body);
  }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
async function navigate(path) {
  await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
}
function record(id, observations) { findings.push({ id, ...observations }); console.log(JSON.stringify(findings.at(-1))); }
try {
  const auth = await request('/auth/login', 'POST', { username: 'tony', password: 'Tony12345!', device: { platform: 'web', name: 'Review repro' } });
  token = auth.access_token;
  roomId = (await request('/rooms', 'POST', { type: 'group', name: `Review isolated ${Date.now()}`, member_ids: [] })).data.room.id;
  // Save refresh once, rather than reinjecting a rotated token on navigation.
  await page.goto(web + '/login');
  await page.evaluate(refresh => localStorage.setItem('orgchat.refresh', refresh), auth.refresh_token);
  await page.goto(`${web}/rooms/${roomId}`);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('message').first()).toBeVisible();
  // Browser boot rotates the access token; use the browser's current one for the node-side probes.
  token = await page.evaluate(async () => (await import('/src/lib/api.ts')).tokenManager.getAccessToken());
  const text = `TC-WEB-REVIEW-001 confirmed ${Date.now()}`;
  await page.getByTestId('composer-input').fill(text);
  const sent = page.waitForResponse(r => r.url().endsWith(`/rooms/${roomId}/messages`) && r.request().method() === 'POST');
  await page.getByTestId('send-button').click();
  await sent;
  await expect(page.getByTestId('message').filter({ hasText: text })).not.toContainText('sending…');
  await navigate('/search');
  await expect(page.getByTestId('search-input')).toBeVisible();
  await navigate(`/rooms/${roomId}`);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.waitForTimeout(500);
  record('TC-WEB-REVIEW-001 / FR-MSG-009', {
    serverContainsConfirmed: (await request(`/rooms/${roomId}/messages`)).data.messages.some(m => m.body === text),
    visibleAfterReturning: await page.getByTestId('message').filter({ hasText: text }).count(),
  });
  await page.reload();
  await expect(page.getByTestId('message').filter({ hasText: text })).toHaveCount(1);
  token = await page.evaluate(async () => (await import('/src/lib/api.ts')).tokenManager.getAccessToken());
  // Disconnect only WebSocket: HTTP remains reachable and healthy.
  await page.evaluate(() => { const p = window.Pusher.instances.at(-1); p.disconnect(); });
  const missed = `TC-WEB-REVIEW-002 missed ${Date.now()}`;
  await request(`/rooms/${roomId}/messages`, 'POST', { body: missed, client_message_id: crypto.randomUUID() });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.Pusher.instances.at(-1).connect());
  await page.waitForTimeout(3000);
  record('TC-WEB-REVIEW-002 / FR-RT-002', {
    socketState: await page.evaluate(() => window.Pusher.instances.at(-1).connection.state),
    serverContainsMissed: (await request(`/rooms/${roomId}/messages`)).data.messages.some(m => m.body === missed),
    visibleAfterReconnect: await page.getByTestId('message').filter({ hasText: missed }).count(),
  });
  // A failed request must become retryable/persisted, not remain 'sending'.
  const failed = `TC-WEB-REVIEW-003 offline ${Date.now()}`;
  await page.route(`**/rooms/${roomId}/messages`, route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue());
  await page.getByTestId('composer-input').fill(failed);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('composer-input')).toHaveValue(failed);
  record('TC-WEB-REVIEW-003 / FR-OFF-002', {
    visibleBubble: await page.getByTestId('message').filter({ hasText: failed }).innerText(),
    serverContainsFailed: (await request(`/rooms/${roomId}/messages`)).data.messages.some(m => m.body === failed),
    persistedOutbox: await page.evaluate(async ({ userId, workspaceId }) => {
      const { roomCache } = await import('/src/lib/cache.ts');
      return roomCache({ userId, workspaceId }).loadOutbox();
    }, { userId: auth.user.id, workspaceId: auth.workspaces.find(w => w.workspace.slug === 'acme').workspace.id }),
  });
  await page.unroute(`**/rooms/${roomId}/messages`);
  // Cache isolation: another account cannot read this owner-only room through REST.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/login/);
  await page.evaluate(async () => (await import('/src/state/session.ts')).useSession.getState().login('duangjai', 'Duangjai12345!'));
  await navigate(`/rooms/${roomId}`);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.waitForTimeout(1000);
  const denied = await page.evaluate(async roomId => {
    try { await (await import('/src/lib/api.ts')).endpoints.messages(roomId, 'acme'); return false; }
    catch { return true; }
  }, roomId);
  record('TC-WEB-REVIEW-004 / FR-WS-003 FR-OFF-001', {
    otherAccountApiDenied: denied,
    oldPrivateTextVisible: await page.getByTestId('message').filter({ hasText: text }).count(),
  });
  await page.screenshot({ path: new URL('cache-isolation.png', import.meta.url).pathname });
  await page.evaluate(async () => (await import('/src/state/session.ts')).useSession.getState().logout());
} finally {
  await writeFile(new URL('reproduction-results.json', import.meta.url), JSON.stringify(findings, null, 2) + '\n');
  await browser.close();
  // Owner token was revoked by logout: authenticate afresh solely to remove our room.
  if (roomId) {
    token = undefined;
    token = (await request('/auth/login', 'POST', { username: 'tony', password: 'Tony12345!' })).access_token;
    await request(`/rooms/${roomId}`, 'DELETE');
    await request('/auth/logout', 'POST');
  }
}
