import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * TC-WEB-PROFPOP-001..017 — FR-PROF-009 / DEC-101 (avatar -> profile popup -> "Chat 1-1").
 *
 * Unlike the other ui/ specs this one runs against the REAL dev stack (Vite :5180 (started by the config) -> api :8000 ->
 * postgres), because the point is the real `POST /rooms` and the real dm_key uniqueness:
 *   node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts e2e/ui/profile-popover.spec.ts
 * Seed: DatabaseSeeder (tony/anna/somchai/duangjai in acme, tony+admin in globex) plus the
 * "PP QA" (acme) and "PP Globex" (globex, tony + anna + admin) groups and a hidden tony<->duangjai DM.
 * Auth: ONE real login per run (login is throttled 5/min/IP); `/auth/refresh` is answered with that
 * session's access token so each test boots as tony without burning a login. Everything else is the real API;
 * route handlers only (a) decorate real GET responses or (b) fake an error status on POST /rooms.
 * One page.route handler per test (the newest route wins in Playwright).
 */
const BASE = process.env.PROFPOP_BASE ?? 'http://127.0.0.1:5180'; // fresh Vite started by playwright.ui.config.ts (a long-running :5173 can serve stale shared modules)
const API = 'http://localhost:8000/api/v1';
const SHOTS = 'e2e-artifacts/ui/screenshots/profile-popover';
mkdirSync(SHOTS, { recursive: true });

function sql(query: string): string {
  return execFileSync('docker', ['exec', 'banana-chat-postgres-1', 'psql', '-U', 'orgchat', '-d', 'orgchat', '-tA', '-c', query], { encoding: 'utf8' }).trim();
}
const uid = (username: string) => sql(`select id from users where username='${username}'`);
const roomId = (workspace: string, name: string) =>
  sql(`select r.id from rooms r join workspaces w on w.id=r.workspace_id where w.slug='${workspace}' and r.name='${name}' and r.type='group'`);
/** dm rooms (any workspace) shared by two users */
function dmRooms(a: string, b: string, workspace?: string): string[] {
  const ws = workspace ? `and r.workspace_id=(select id from workspaces where slug='${workspace}')` : '';
  return sql(`select r.id from rooms r where r.type='dm' and r.deleted_at is null ${ws}
    and r.id in (select room_id from room_members where user_id='${uid(a)}')
    and r.id in (select room_id from room_members where user_id='${uid(b)}')`).split('\n').filter(Boolean);
}
function resetState() {
  // no tony<->anna DM anywhere (deleting the room cascades members/messages)
  for (const id of dmRooms('tony', 'anna')) sql(`delete from rooms where id='${id}'`);
  // tony<->duangjai DM stays but is hidden by tony
  for (const id of dmRooms('tony', 'duangjai')) sql(`update room_members set hidden_at=now() where room_id='${id}' and user_id='${uid('tony')}'`);
}

let session: { access: string } | null = null;
async function realSession() {
  if (session) return session;
  // Playwright restarts the worker after every failed test and module state is lost; a login costs
  // 1 of 10 per 15 min for the username, so the access token is cached on disk for its lifetime.
  const cache = `${tmpdir()}/profpop-e2e-session.json`;
  if (existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 10 * 60_000) { session = JSON.parse(readFileSync(cache, 'utf8')); return session!; }
  const login = () => fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tony', password: 'Tony12345!', platform: 'web', name: 'profpop e2e' }) });
  let res = await login();
  if (res.status === 429) { await new Promise(r => setTimeout(r, Math.min(Number(res.headers.get('retry-after') ?? 60), 65) * 1000 + 500)); res = await login(); }
  if (res.status !== 200) throw new Error(`tony login -> ${res.status}`);
  const body = await res.json();
  session = { access: (body.data ?? body).access_token };
  writeFileSync(cache, JSON.stringify(session));
  return session;
}
const apiGet = async (path: string, slug = 'acme') => {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${(await realSession()).access}`, 'X-Workspace-Id': slug, Accept: 'application/json' } });
  return (await res.json()).data;
};

type Mode = {
  /** replace the response of POST /rooms (error cases) */
  postRooms?: (route: Route, nth: number) => Promise<void> | void;
  /** decorate real GET /rooms/:id/messages JSON */
  messages?: (json: any) => void;
  /** decorate real GET /rooms/:id/members JSON */
  members?: (json: any) => void;
};
async function boot(page: Page, mode: Mode = {}, workspace = 'acme') {
  const { access } = await realSession();
  const posts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/v1\/rooms$/.test(r.url())) posts.push(r.url()); });
  await page.addInitScript(ws => {
    if (localStorage.getItem('orgchat.refresh') === null) localStorage.setItem('orgchat.refresh', 'profpop-e2e');
    localStorage.setItem('orgchat.lastWorkspace', ws);
  }, workspace);
  let nth = 0;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path === '/auth/refresh') return route.fulfill({ json: { access_token: access, refresh_token: 'profpop-e2e', expires_in: 3600 } });
    if (path === '/rooms' && request.method() === 'POST' && mode.postRooms) return mode.postRooms(route, nth++);
    if (request.method() === 'GET' && mode.messages && /^\/rooms\/[^/]+\/messages$/.test(path)) {
      const response = await route.fetch();
      const json = await response.json();
      mode.messages(json);
      return route.fulfill({ response, json });
    }
    if (request.method() === 'GET' && mode.members && /^\/rooms\/[^/]+\/members$/.test(path)) {
      const response = await route.fetch();
      const json = await response.json();
      mode.members(json);
      return route.fulfill({ response, json });
    }
    return route.continue();
  });
  return { posts };
}
async function open(page: Page, id: string) {
  await page.goto(`${BASE}/rooms/${id}`);
  await expect(page.getByTestId('message').first()).toBeVisible({ timeout: 20_000 });
}
const rowOf = (page: Page, text: string) => page.getByTestId('message').filter({ hasText: text }).first();
const avatarBtn = (page: Page, text: string) => rowOf(page, text).getByTestId('profile-avatar-button');
const popover = (page: Page) => page.getByTestId('profile-popover');
const dmBtn = (page: Page) => page.getByTestId('profile-dm-button');
const notFound = { status: 404, json: { error: { code: 'NOT_FOUND', message: 'nope' } } };
const sizeOf = (page: Page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight }));
async function shot(page: Page, name: string, width: number) {
  await page.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
}

test.beforeAll(async () => { test.setTimeout(120_000); await realSession(); });

for (const width of [1440, 390, 320]) {
  test.describe(`${width}px profile popover`, () => {
    test.beforeEach(async ({ page }) => {
      resetState();
      await page.setViewportSize({ width, height: 844 });
    });
    const only = (widths: number[]) => test.skip(!widths.includes(width), `not run at ${width}px`);

    test('TC-WEB-PROFPOP-001: group avatar is a named button that opens a dialog with name and @username', async ({ page }) => {
      only([1440, 390]);
      await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const button = avatarBtn(page, 'somchai says hi');
      await expect(button).toHaveAttribute('aria-label', 'ดูโปรไฟล์: สมชาย ใจดี');
      await expect(page.getByRole('button', { name: 'ดูโปรไฟล์: สมชาย ใจดี' }).first()).toBeVisible();
      await button.click();
      await expect(popover(page)).toBeVisible();
      expect(await popover(page).evaluate(d => (d as HTMLDialogElement).open && d.matches(':modal'))).toBe(true);
      await expect(popover(page).getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
      await expect(popover(page)).toContainText('@somchai');
      // the sender NAME is the second entry point and opens the same card
      await page.keyboard.press('Escape');
      await rowOf(page, 'somchai says hi').getByTestId('profile-name-button').click();
      await expect(popover(page).getByRole('heading', { name: 'สมชาย ใจดี' })).toBeVisible();
    });

    test('TC-WEB-PROFPOP-002: no trigger in a DM room or on own messages', async ({ page }) => {
      only([1440, 390]);
      await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      await expect(rowOf(page, 'tony own message').getByTestId('profile-avatar-button')).toHaveCount(0);
      await expect(rowOf(page, 'tony own message').getByTestId('profile-name-button')).toHaveCount(0);
      await expect(avatarBtn(page, 'somchai says hi')).toHaveCount(1); // positive control
      const dm = dmRooms('tony', 'somchai', 'acme')[0]!;
      await open(page, dm);
      await expect(page.getByTestId('profile-avatar-button')).toHaveCount(0);
      await expect(page.getByTestId('profile-name-button')).toHaveCount(0);
    });

    test('TC-WEB-PROFPOP-003: owner/admin role and presence shown with a roster entry, absent without', async ({ page }) => {
      only([1440, 390]);
      await boot(page, { members: json => {
        const list = json.data as any[];
        const anna = list.find(m => m.username === 'anna');
        if (anna) anna.presence = 'online';
        const somchai = list.find(m => m.username === 'somchai');
        if (somchai) delete somchai.presence; // member with neither presence nor a special role
      } });
      await open(page, roomId('acme', 'Engineering'));
      await avatarBtn(page, 'ได้ค่ะ วันนี้').click();
      await expect(popover(page).getByTestId('profile-presence')).toContainText('ออนไลน์');
      await expect(popover(page)).toContainText('ผู้ดูแลกลุ่ม'); // anna is room admin
      await shot(page, 'role-presence-light', width);
      await page.keyboard.press('Escape');
      // member with no presence/role -> no meta line at all
      await avatarBtn(page, 'รับทราบครับ').click();
      await expect(popover(page)).toBeVisible();
      await expect(popover(page).getByTestId('profile-presence')).toHaveCount(0);
      await expect(popover(page).locator('.bc-pp-role')).toHaveCount(0);
      await expect(popover(page).locator('.bc-pp-meta')).toHaveCount(0);
      // roster missing entirely (members request returns []) -> still opens, no meta
      const page2 = await page.context().newPage();
      await page2.setViewportSize({ width, height: 844 });
      await boot(page2, { members: json => { json.data = []; } });
      await open(page2, roomId('acme', 'Engineering'));
      await avatarBtn(page2, 'ได้ค่ะ วันนี้').click();
      await expect(popover(page2)).toBeVisible();
      await expect(popover(page2).locator('.bc-pp-meta')).toHaveCount(0);
    });

    test('TC-WEB-PROFPOP-004: existing normal DM in the list navigates without POST /rooms', async ({ page }) => {
      only([1440, 390]);
      const { posts } = await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const dm = dmRooms('tony', 'somchai', 'acme')[0]!;
      // wait until the sidebar has loaded the room list the popup reads
      await page.waitForResponse(r => r.url().includes('/api/v1/rooms') && r.request().method() === 'GET' && r.ok());
      await avatarBtn(page, 'somchai says hi').click();
      await dmBtn(page).click();
      await expect(page).toHaveURL(new RegExp(`/rooms/${dm}$`));
      await expect(popover(page)).toHaveCount(0);
      expect(posts).toHaveLength(0);
    });

    test('TC-WEB-PROFPOP-005: DM hidden by me (not in list) -> POST /rooms 200 then navigate', async ({ page }) => {
      only([1440, 390]);
      const { posts } = await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const hidden = dmRooms('tony', 'duangjai', 'acme')[0]!;
      await avatarBtn(page, 'duangjai here').click();
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'),
        dmBtn(page).click(),
      ]);
      expect(response.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`/rooms/${hidden}$`));
      expect(posts).toHaveLength(1);
      expect(dmRooms('tony', 'duangjai', 'acme')).toHaveLength(1);
    });

    test('TC-WEB-PROFPOP-006: no DM -> real POST /rooms 201, navigate, sidebar lists the new DM', async ({ page }) => {
      only([1440, 390]);
      const { posts } = await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      expect(dmRooms('tony', 'anna', 'acme')).toHaveLength(0);
      await avatarBtn(page, 'anna one').click();
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'),
        dmBtn(page).click(),
      ]);
      expect(response.status()).toBe(201);
      const created = dmRooms('tony', 'anna', 'acme');
      expect(created).toHaveLength(1);
      await expect(page).toHaveURL(new RegExp(`/rooms/${created[0]}$`));
      expect(posts).toHaveLength(1);
      // rooms list was invalidated: the server list (what the sidebar renders) now holds the DM
      const list = await apiGet('/rooms');
      expect(list.some((r: any) => r.room.id === created[0] && r.other_user?.username === 'anna')).toBe(true);
      if (width > 760) await expect(page.locator('aside').getByText('Anna Garcia').first()).toBeVisible();
      else await expect(page.locator('.bc-chat-header')).toContainText('Anna Garcia');
    });

    test('TC-WEB-PROFPOP-007: 404 -> "unavailable" state and the DM button is removed', async ({ page }) => {
      only([1440, 390]);
      await boot(page, { postRooms: route => route.fulfill(notFound) });
      await open(page, roomId('acme', 'PP QA'));
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).click();
      await expect(page.getByTestId('profile-unavailable')).toBeVisible();
      await expect(dmBtn(page)).toHaveCount(0);
      await expect(popover(page)).toBeVisible();
      await shot(page, 'unavailable-light', width);
    });

    test('TC-WEB-PROFPOP-008: 403 -> forbidden message, button re-enabled', async ({ page }) => {
      only([1440, 390]);
      await boot(page, { postRooms: route => route.fulfill({ status: 403, json: { error: { code: 'ROOM_FORBIDDEN', message: 'no' } } }) });
      await open(page, roomId('acme', 'PP QA'));
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).click();
      await expect(page.getByTestId('profile-dm-error')).toContainText('ไม่มีสิทธิ์');
      await expect(dmBtn(page)).toBeEnabled();
      await expect(popover(page)).toHaveAttribute('aria-busy', 'false');
    });

    test('TC-WEB-PROFPOP-009: network error -> message, retry works (real API on the retry)', async ({ page }) => {
      only([1440, 390]);
      await boot(page, { postRooms: (route, nth) => nth === 0 ? route.abort('failed') : route.continue() });
      await open(page, roomId('acme', 'PP QA'));
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).click();
      await expect(page.getByTestId('profile-dm-error')).toContainText('เชื่อมต่อไม่ได้');
      await expect(dmBtn(page)).toBeEnabled();
      await dmBtn(page).click();
      await expect.poll(() => dmRooms('tony', 'anna', 'acme').length).toBe(1);
      await expect(page).toHaveURL(new RegExp(`/rooms/${dmRooms('tony', 'anna', 'acme')[0]}$`));
    });

    test('TC-WEB-PROFPOP-010: double click sends exactly one POST and leaves exactly one DM row', async ({ page }) => {
      only([1440, 390]);
      const { posts } = await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).dblclick();
      await expect.poll(() => dmRooms('tony', 'anna', 'acme').length).toBe(1);
      await expect(popover(page)).toHaveCount(0);
      expect(posts).toHaveLength(1);
      expect(sql(`select count(*) from rooms where type='dm' and dm_key=(select dm_key from rooms where id='${dmRooms('tony', 'anna', 'acme')[0]}')`)).toBe('1');
    });

    test('TC-WEB-PROFPOP-010b: Enter then click on the same open popup is still one POST', async ({ page }) => {
      only([1440]);
      const { posts } = await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      await avatarBtn(page, 'anna one').focus();
      await page.keyboard.press('Enter');
      await expect(popover(page)).toBeVisible();
      await dmBtn(page).focus();
      await page.keyboard.press('Enter');
      await dmBtn(page).click({ timeout: 500, noWaitAfter: true }).catch(() => undefined); // may already be closed: that is the point
      await expect.poll(() => dmRooms('tony', 'anna', 'acme').length).toBe(1);
      expect(posts).toHaveLength(1);
    });

    test('TC-WEB-PROFPOP-011: closing while the request is in flight -> no navigation afterwards', async ({ page }) => {
      only([1440, 390]);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let seen = false;
      await boot(page, { postRooms: async route => { seen = true; await gate; await route.fulfill({ status: 201, json: { data: { room: { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', type: 'dm' } } } }); } });
      const qa = roomId('acme', 'PP QA');
      await open(page, qa);
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).click();
      await expect(popover(page)).toHaveAttribute('aria-busy', 'true');
      await expect(dmBtn(page)).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(popover(page)).toHaveCount(0);
      expect(seen).toBe(true);
      release();
      await page.waitForTimeout(800);
      await expect(page).toHaveURL(new RegExp(`/rooms/${qa}$`));
      await expect(popover(page)).toHaveCount(0);
    });

    test('TC-WEB-PROFPOP-012: room change closes the popup and drops the in-flight result', async ({ page }) => {
      only([1440, 390]);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await boot(page, { postRooms: async route => { await gate; await route.fulfill({ status: 201, json: { data: { room: { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', type: 'dm' } } } }); } });
      const qa = roomId('acme', 'PP QA');
      const eng = roomId('acme', 'Engineering');
      await open(page, qa);
      await avatarBtn(page, 'anna one').click();
      await dmBtn(page).click();
      await expect(popover(page)).toHaveAttribute('aria-busy', 'true');
      // a modal dialog blocks the sidebar, so drive the router the way back/forward / a deep link would
      await page.evaluate(id => { history.pushState({}, '', `/rooms/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, eng);
      await expect(page).toHaveURL(new RegExp(`/rooms/${eng}$`));
      await expect(popover(page)).toHaveCount(0);
      release();
      await page.waitForTimeout(800);
      await expect(page).toHaveURL(new RegExp(`/rooms/${eng}$`));
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    });

    test('TC-WEB-PROFPOP-012b: second shared workspace — DM works in globex (was 404 on the global dm_key)', async ({ page }) => {
      only([1440, 390]);
      // anna and tony share acme AND globex
      const { posts } = await boot(page, {}, 'globex');
      await open(page, roomId('globex', 'PP Globex'));
      await page.waitForResponse(r => r.url().includes('/api/v1/rooms') && r.request().method() === 'GET' && r.ok());
      await avatarBtn(page, 'anna in globex').click();
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'),
        dmBtn(page).click(),
      ]);
      expect([200, 201]).toContain(response.status());
      const globexDm = dmRooms('tony', 'anna', 'globex');
      expect(globexDm).toHaveLength(1);
      await expect(page).toHaveURL(new RegExp(`/rooms/${globexDm[0]}$`));
      expect(posts).toHaveLength(1);
      // now the same pair also gets one in acme: two rows, different workspaces, same dm_key
      await page.context().clearCookies();
      const acmePage = await page.context().newPage();
      await acmePage.setViewportSize({ width, height: 844 });
      await boot(acmePage, {}, 'acme');
      await open(acmePage, roomId('acme', 'PP QA'));
      await avatarBtn(acmePage, 'anna one').click();
      const [r2] = await Promise.all([
        acmePage.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'),
        dmBtn(acmePage).click(),
      ]);
      expect(r2.status()).toBe(201);
      const both = dmRooms('tony', 'anna');
      expect(both).toHaveLength(2);
      expect(sql(`select count(distinct workspace_id) from rooms where id in ('${both.join("','")}')`)).toBe('2');
      expect(sql(`select count(distinct dm_key) from rooms where id in ('${both.join("','")}')`)).toBe('1');
    });

    test('TC-WEB-PROFPOP-013: AI bot and null sender get no button and no popup', async ({ page }) => {
      only([1440, 390]);
      await boot(page, { messages: json => {
        const list: any[] = json.data.messages ?? json.data;
        const text = list.filter(m => m.type === 'text' && m.sender);
        const a = text.find(m => m.body === 'somchai says hi')!;
        a.sender = { id: 'bot-1', username: '__banana_ai_bot__', display_name: 'Banana AI', avatar_attachment_id: null };
        a.body = 'bot says hello';
        const b = text.find(m => m.body === 'duangjai here')!;
        b.sender = null; b.sender_id = null; b.body = 'nobody says hello';
      } });
      await open(page, roomId('acme', 'PP QA'));
      for (const body of ['bot says hello', 'nobody says hello']) {
        const row = rowOf(page, body);
        await expect(row).toBeVisible();
        await expect(row.getByTestId('profile-avatar-button')).toHaveCount(0);
        await expect(row.getByTestId('profile-name-button')).toHaveCount(0);
        await row.locator('.bc-message-avatar').first().click({ force: true }).catch(() => undefined);
        await row.locator('.bc-message-bubble').click({ position: { x: 4, y: 4 } });
        await expect(popover(page)).toHaveCount(0);
      }
      await expect(avatarBtn(page, 'anna one')).toHaveCount(1); // control: real people still have it
    });

    test('TC-WEB-PROFPOP-014: grouped follow-up trigger is not focusable; first row of a run is', async ({ page }) => {
      only([1440, 390]);
      await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const first = avatarBtn(page, 'anna one');
      const second = avatarBtn(page, 'anna two grouped');
      await expect(rowOf(page, 'anna two grouped')).toHaveAttribute('data-grouped', 'true');
      await expect(second).toHaveAttribute('tabindex', '-1');
      await expect(second).toHaveAttribute('aria-hidden', 'true');
      await expect(first).not.toHaveAttribute('tabindex', /.*/);
      await expect(page.getByRole('button', { name: 'ดูโปรไฟล์: Anna Garcia' })).toHaveCount(2); // name + avatar of run head only
      await first.focus();
      await expect(first).toBeFocused();
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-grouped="true"]') && (document.activeElement as HTMLElement).dataset.testid?.startsWith('profile-'))).toBeFalsy();
      }
    });

    test('TC-WEB-PROFPOP-015: phone widths show a 24px avatar, bottom sheet, no horizontal scroll', async ({ page }) => {
      await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const avatar = rowOf(page, 'somchai says hi').locator('.bc-message-avatar');
      const visible = await avatar.isVisible();
      // soft: if a stylesheet still hides the avatar (chat.css `.bc-chat-shell .bc-message-avatar{display:none}`) report it, then carry on via the name
      expect.soft(visible, 'sender avatar is visible at this width').toBe(true);
      if (visible) {
        const box = (await avatar.boundingBox())!;
        if (width <= 760) { expect(Math.round(box.width)).toBe(24); expect(Math.round(box.height)).toBe(24); }
        else expect(Math.round(box.width)).toBeGreaterThanOrEqual(28);
        // the tap target is bigger than the visual avatar and does not overlap the bubble
        const trigger = (await avatarBtn(page, 'somchai says hi').boundingBox())!;
        const bubble = (await rowOf(page, 'somchai says hi').locator('.bc-message-bubble').boundingBox())!;
        expect(trigger.x + trigger.width).toBeLessThanOrEqual(bubble.x + 1);
      }
      await shot(page, 'room-light', width);
      await (visible ? avatarBtn(page, 'somchai says hi') : rowOf(page, 'somchai says hi').getByTestId('profile-name-button')).click();
      await expect(popover(page)).toBeVisible();
      await page.waitForTimeout(400); // sheet animation
      const rect = (await popover(page).boundingBox())!;
      const { sw, iw, ih } = await sizeOf(page);
      expect(sw - iw).toBeLessThanOrEqual(1);
      expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(iw + 0.5);
      expect(rect.y + rect.height).toBeLessThanOrEqual(ih + 0.5);
      if (width <= 760) {
        expect(Math.round(rect.width)).toBe(iw); // full-width sheet
        expect(Math.round(rect.y + rect.height)).toBe(ih); // anchored to the bottom
      } else {
        expect(rect.width).toBeLessThanOrEqual(300);
      }
      expect((await dmBtn(page).boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await shot(page, 'popup-light', width);
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot(page, 'popup-dark', width);
      await page.keyboard.press('Escape');
      await shot(page, 'room-dark', width);
    });

    test('TC-WEB-PROFPOP-016: keyboard — Enter opens, Tab order close -> Chat 1-1, Escape closes with focus back, outside click closes', async ({ page }) => {
      only([1440, 390]);
      await boot(page);
      await open(page, roomId('acme', 'PP QA'));
      const trigger = avatarBtn(page, 'somchai says hi');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(popover(page)).toBeVisible();
      await expect.soft(dmBtn(page), 'tech-lead B3: opening focuses the Chat 1-1 button').toBeFocused();
      await dmBtn(page).focus(); // continue the order check independently of the focus-on-open assertion above
      await page.keyboard.press('Shift+Tab');
      await expect(popover(page).getByRole('button', { name: 'ปิด' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dmBtn(page)).toBeFocused();
      for (let i = 0; i < 4; i++) { // modal: focus may leave to browser chrome (body) but never lands on the page behind
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !document.activeElement?.closest('[data-testid="message"], aside, .bc-composer'))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(popover(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // outside click
      await trigger.click();
      await expect(popover(page)).toBeVisible();
      await page.mouse.click(4, 4);
      await expect(popover(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      // close button
      await trigger.click();
      await popover(page).getByRole('button', { name: 'ปิด' }).click();
      await expect(popover(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test('TC-WEB-PROFPOP-017: GIF avatar is paused (static md) under prefers-reduced-motion, animated otherwise', async ({ page }) => {
      only([1440]);
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHJsMMgAAAABJRU5ErkJggg==', 'base64');
      const gif = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64');
      await page.route('**/__pp/**', route => route.fulfill({ body: route.request().url().endsWith('.gif') ? gif : png, contentType: route.request().url().endsWith('.gif') ? 'image/gif' : 'image/png' }));
      const avatar = { sm: `${BASE}/__pp/sm.png`, md: `${BASE}/__pp/md.png`, animated: `${BASE}/__pp/anim.gif` };
      const decorate = (json: any) => { for (const m of json.data.messages ?? json.data) if (m.sender?.username === 'anna') m.sender.avatar = avatar; };
      for (const reduced of [false, true]) {
        const p = await page.context().newPage();
        await p.setViewportSize({ width, height: 844 });
        await p.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
        // the first page's __pp route is page-scoped: register on the new page as well
        await p.route('**/__pp/**', route => route.fulfill({ body: route.request().url().endsWith('.gif') ? gif : png, contentType: route.request().url().endsWith('.gif') ? 'image/gif' : 'image/png' }));
        await boot(p, { messages: decorate });
        await open(p, roomId('acme', 'PP QA'));
        await avatarBtn(p, 'anna one').click();
        const img = popover(p).getByTestId('avatar-photo');
        await expect(img).toHaveAttribute('src', reduced ? avatar.md : avatar.animated);
        await p.close();
      }
    });
  });
}
