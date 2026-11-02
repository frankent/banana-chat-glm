import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installChatFixture } from './fixtures';

// FR-PCHAT-040..043 — password group rooms: create dialog, guest gate, guest chat, video entry.
// API and Reverb are synthetic (see README); screenshots are review evidence, not pixel goldens.

const CODE = 'a'.repeat(64);
const ROOM_ID = '01hx5k8m3p9q2r7s4t6v1w0pcr';
const PASSWORD = 'correct-horse-battery';
const shot = (page: Page, testInfo: { project: { outputDir: string } }, name: string) =>
  page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots', `pchat-${name}.png`), fullPage: false });

const staffRoom = {
  id: ROOM_ID, customer_name: 'Friday planning', provider_name: 'Banana Studio', status: 'in_progress', status_public: 'open',
  kind: 'group', has_meeting: true, created_by: 'ui-me', locale: 'en', last_seq: 4, needs_reply: false,
  created_at: '2026-11-02T09:00:00Z', expires_at: '2026-12-02T09:00:00Z', last_message_at: null, assigned_to: null, claimed_at: null, first_response_at: null,
  external_ref: null, last_visitor_seq: 0, last_agent_seq: 0, my_last_read_seq: 0, unread_count: 0, closed_at: null, meta: null,
};

async function memberFixture(page: Page) {
  await installChatFixture(page);
  const created: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/public-chat/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/summary')) return route.fulfill({ json: { data: { feature_enabled: true, summary: { new: 0, problem: 0, needs_reply: 0, done: 0, in_progress: 0, total: 1 } } } });
    if (path === '/public-chat/rooms' && req.method() === 'POST') {
      created.push(req.postDataJSON());
      return route.fulfill({ status: 201, json: { data: { room: staffRoom, url: `http://127.0.0.1:5180/support/${CODE}` } } });
    }
    if (path === '/public-chat/rooms') return route.fulfill({ json: { data: { rooms: [staffRoom], next_cursor: null } } });
    return route.fallback();
  });
  return created;
}

const msg = (seq: number, over: Record<string, unknown>) => ({
  id: `m${seq}`, seq, sender_kind: 'visitor', display_name: 'Nok', guest_id: 'g-nok', type: 'text', body: 'x',
  system_event: null, system_meta: null, reply_to: null, attachments: [], deleted: false,
  created_at: `2026-11-02T10:0${seq}:00Z`, ...over,
});

async function guestFixture(page: Page, opts: { requiresPassword: boolean; hasMeeting?: boolean }) {
  await installChatFixture(page);
  let passwordAttempts = 0;
  await page.route(`**/api/v1/public-chat/${CODE}**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(`/api/v1/public-chat/${CODE}`, '');
    const room = { id: ROOM_ID, customer_name: 'Friday planning', provider_name: 'Banana Studio', status_public: 'open', locale: 'en', created_at: null, expires_at: '2026-12-02T09:00:00Z', last_seq: 4 };
    if (path === '' || path === '/') {
      const authed = !opts.requiresPassword || !!req.headers()['x-pchat-guest'];
      return route.fulfill({ json: { data: { room, viewer: authed ? { kind: 'guest', display_name: 'Mali', guest_id: 'g-mali' } : null, feature_enabled: true, can_send: authed, closed_reason: null, requires_password: !authed, has_meeting: !!opts.hasMeeting } } });
    }
    if (path === '/join') {
      const body = req.postDataJSON() as { password: string; display_name: string };
      passwordAttempts += 1;
      if (body.password !== PASSWORD) return route.fulfill({ status: 403, json: { error: { code: 'PCHAT_PASSWORD_INVALID', message: 'bad password' } } });
      return route.fulfill({ json: { data: { guest_token: `pcg_${'a'.repeat(64)}`, guest: { id: 'g-mali', display_name: body.display_name } } } });
    }
    if (path.startsWith('/messages') && req.method() === 'GET') {
      return route.fulfill({ json: { data: { last_seq: 4, messages: [
        msg(1, { body: 'Can we start at 3?' }),
        msg(2, { sender_kind: 'agent', display_name: 'Anna', guest_id: null, body: 'Yes, that works. ✅' }),
        msg(3, { display_name: 'Mali', guest_id: 'g-mali', body: 'ผมจะเอาเอกสารมาด้วยครับ' }),
        msg(4, { sender_kind: 'system', display_name: null, guest_id: null, type: 'system', body: null, system_event: 'status_changed', system_meta: { from: 'open', to: 'open' } }),
      ] } } });
    }
    return route.fulfill({ status: 204 });
  });
  return { attempts: () => passwordAttempts };
}

async function luminance(loc: import('@playwright/test').Locator) {
  return loc.evaluate((el) => {
    let n: Element | null = el;
    while (n) {
      const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (m && (m[3] === undefined || Number(m[3]) > 0.5)) return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
      n = n.parentElement;
    }
    return 255;
  });
}

const sizes = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }];

for (const size of sizes) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`TC-UI-PCHAT-001 create dialog is centred, labelled and usable — ${size.name}/${scheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: scheme });
      await memberFixture(page);
      await page.goto('/public-chat');
      await page.getByRole('button', { name: /new group room/i }).click();
      const dialog = page.locator('dialog.pc-dialog[open]');
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      if (size.name === 'desktop') {
        expect(Math.abs(box.x + box.width / 2 - size.width / 2)).toBeLessThan(2);
        expect(Math.abs(box.y + box.height / 2 - size.height / 2)).toBeLessThan(2);
      } else {
        expect(box.x).toBeLessThanOrEqual(1);
        expect(box.width).toBeGreaterThanOrEqual(size.width - 1);
      }
      await expect(page.getByLabel(/room name/i)).toBeVisible();
      await expect(page.getByLabel(/room password/i)).toBeVisible();
      // member app is light-only: an OS dark scheme must not darken it
      expect(await luminance(dialog)).toBeGreaterThan(200);
      expect(await luminance(page.locator('.bc-pchat-queue'))).toBeGreaterThan(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await shot(page, testInfo, `create-${size.name}-${scheme}`);
    });

    test(`TC-UI-PCHAT-004 guest password gate — ${size.name}/${scheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: scheme });
      await guestFixture(page, { requiresPassword: true, hasMeeting: true });
      await page.goto(`/support/${CODE}`);
      await expect(page.getByLabel(/room password/i).or(page.getByLabel(/password/i)).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /join room|join/i }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await shot(page, testInfo, `gate-${size.name}-${scheme}`);
    });
  }
}

test('TC-UI-PCHAT-002 create: validates, sends the draft, shows link + password with separate copy', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const created = await memberFixture(page);
  await page.goto('/public-chat');
  await page.getByRole('button', { name: /new group room/i }).click();
  const submit = page.getByRole('button', { name: /create room/i });
  await submit.click();
  await expect(page.locator('dialog.pc-dialog[open] [aria-invalid="true"]').first()).toBeVisible();
  expect(created).toHaveLength(0);
  await page.getByLabel(/room name/i).fill('Friday planning');
  await page.getByRole('button', { name: /generate password/i }).click();
  await shot(page, testInfo, 'create-filled');
  await page.getByRole('checkbox', { name: /video meeting/i }).check();
  await page.getByRole('button', { name: /7 days/i }).click();
  await submit.click();
  await expect(page.getByRole('heading', { name: /room ready/i })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ title: 'Friday planning', expires_in_days: 7, with_meeting: true });
  expect(String(created[0].password).length).toBeGreaterThanOrEqual(12);
  await expect(page.locator('dialog.pc-dialog[open] input[readonly]').first()).toHaveValue(new RegExp(`/support/${CODE}$`));
  await page.getByRole('button', { name: /copy link/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/support/${CODE}`);
  await page.getByRole('button', { name: /copy password/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(created[0].password);
  await shot(page, testInfo, 'create-success');
});

test('TC-UI-PCHAT-005 gate: wrong password stays on the gate with the name kept; right password enters the chat', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const g = await guestFixture(page, { requiresPassword: true });
  await page.goto(`/support/${CODE}`);
  const pw = page.getByLabel(/password/i).first();
  await pw.fill('nope-nope');
  await page.getByLabel(/your name|name/i).last().fill('Mali');
  await page.getByRole('button', { name: /join/i }).last().click();
  await expect(page.getByText(/password is not correct|not correct/i)).toBeVisible();
  await expect(page.getByLabel(/your name|name/i).last()).toHaveValue('Mali');
  expect(g.attempts()).toBe(1);
  await shot(page, testInfo, 'gate-wrong-password');
  await pw.fill(PASSWORD);
  await page.getByRole('button', { name: /join/i }).last().click();
  await expect(page.getByText('Can we start at 3?')).toBeVisible();
  expect(await page.evaluate((c) => localStorage.getItem(`bc.pchat.guest.${c}`), CODE)).toMatch(/^pcg_/);
});

test('TC-UI-PCHAT-006 guest chat: me / guest / staff are distinguishable; no horizontal scroll', async ({ page }, testInfo) => {
  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await guestFixture(page, { requiresPassword: false, hasMeeting: true });
    await page.addInitScript((c) => localStorage.setItem(`bc.pchat.guest.${c}`, `pcg_${'a'.repeat(64)}`), CODE);
    await page.goto(`/support/${CODE}`);
    await expect(page.getByText('Can we start at 3?')).toBeVisible();
    await expect(page.getByText('ผมจะเอาเอกสารมาด้วยครับ')).toBeVisible();
    await expect(page.getByText(/staff/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /join video/i })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await shot(page, testInfo, `chat-${size.name}`);
  }
});

test('TC-UI-PCHAT-007 video: Join video opens a pre-join with camera and microphone off, cancel returns to chat', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await guestFixture(page, { requiresPassword: false, hasMeeting: true });
  await page.addInitScript((c) => localStorage.setItem(`bc.pchat.guest.${c}`, `pcg_${'a'.repeat(64)}`), CODE);
  await page.goto(`/support/${CODE}`);
  await page.getByRole('button', { name: /join video/i }).click();
  const dialog = page.locator('dialog.pc-dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/camera off/i);
  await expect(dialog).toContainText(/microphone off/i);
  await shot(page, testInfo, 'prejoin');
  await dialog.getByRole('button', { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Can we start at 3?')).toBeVisible();
});

test('TC-UI-PCHAT-008 forget this device clears the stored token and returns to the gate', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await guestFixture(page, { requiresPassword: true });
  await page.addInitScript((c) => localStorage.setItem(`bc.pchat.guest.${c}`, `pcg_${'a'.repeat(64)}`), CODE);
  await page.goto(`/support/${CODE}`);
  await expect(page.getByText('Can we start at 3?')).toBeVisible();
  await page.locator('summary[aria-label]').click();
  await page.getByRole('button', { name: /forget this device/i }).first().click();
  await page.locator('dialog.pc-dialog[open]').getByRole('button', { name: /forget this device/i }).click();
  await expect(page.getByLabel(/password/i).first()).toBeVisible();
  await expect.poll(() => page.evaluate((c) => localStorage.getItem(`bc.pchat.guest.${c}`), CODE)).toBeNull();
});

for (const size of sizes) {
  test(`TC-UI-PCHAT-009 queue row for a group room keeps its content inside the row — ${size.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await memberFixture(page);
    await page.goto('/public-chat');
    const row = page.locator('.bc-pchat-row').first();
    await expect(row).toBeVisible();
    await shot(page, testInfo, `list-${size.name}`);
    const rb = (await row.boundingBox())!;
    const who = (await row.locator('.bc-pchat-row-who').boundingBox())!;
    const badges = page.locator('.bc-pchat-row .pc-badge');
    await expect(badges).toHaveCount(2);
    const b0 = (await badges.nth(0).boundingBox())!;
    const b1 = (await badges.nth(1).boundingBox())!;
    expect(who.y).toBeGreaterThanOrEqual(rb.y - 1);
    expect(who.y + who.height).toBeLessThanOrEqual(rb.y + rb.height + 1);
    expect(b1.x).toBeGreaterThanOrEqual(b0.x + b0.width + 2);
    expect(who.x).toBeLessThan(rb.x + 40);
  });
}

test('TC-UI-PCHAT-010 staff room page shows Copy link in the header and the link in the tools drawer', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await memberFixture(page);
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}/link`, (r) => r.fulfill({ json: { data: { url: `http://127.0.0.1:5180/support/${CODE}` } } }));
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}`, (r) => r.fulfill({ json: { data: { room: staffRoom } } }));
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}/messages**`, (r) => r.fulfill({ json: { data: { messages: [], last_seq: 0 } } }));
  await page.goto(`/public-chat/${ROOM_ID}`);
  await page.getByRole('button', { name: /^copy link$/i }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/support/${CODE}`);
  await shot(page, testInfo, 'room-copy-link');
  await page.getByRole('button', { name: /room tools/i }).click();
  await expect(page.locator('dialog.pc-dialog[open] input[readonly]').first()).toHaveValue(new RegExp(`/support/${CODE}$`));
  await shot(page, testInfo, 'room-tools-link');
});

test('TC-UI-PCHAT-011 staff room page stays light under an OS dark scheme', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await memberFixture(page);
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}/link`, (r) => r.fulfill({ json: { data: { url: `http://127.0.0.1:5180/support/${CODE}` } } }));
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}`, (r) => r.fulfill({ json: { data: { room: staffRoom } } }));
  await page.route(`**/api/v1/public-chat/rooms/${ROOM_ID}/messages**`, (r) => r.fulfill({ json: { data: { messages: [], last_seq: 0 } } }));
  await page.goto(`/public-chat/${ROOM_ID}`);
  await expect(page.locator('.bc-pchat-room')).toBeVisible();
  expect(await luminance(page.locator('.bc-pchat-room'))).toBeGreaterThan(200);
  await shot(page, testInfo, 'room-os-dark-stays-light');
});
