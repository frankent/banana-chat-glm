import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { RoomListItem } from '@banana-chat/shared';
import { installChatFixture, me, message } from './fixtures';

/**
 * FR-ROOM-004 / DEC-096 — add workspace members who are not in the group yet, with
 * type-to-search. API, directory and Reverb are all synthetic (page.route); nothing real is touched.
 */
const shots = resolve(import.meta.dirname, '../../e2e-artifacts/ui/screenshots/add-members');
const person = (n: number, name = `Person ${String(n).padStart(2, '0')}`) => ({
  id: `ui-p${n}`, username: `p${n}`, display_name: name, avatar_attachment_id: null, avatar: null,
});
const people = [
  person(1, 'Mintra Chen'), person(2, 'Somchai Wong'), person(3, 'Minnie Park'), person(4, 'Anna Lee'),
  ...Array.from({ length: 126 }, (_, i) => person(i + 5)),
];
const alreadyIn = new Set(['ui-p1']);

interface Server {
  directory: string[];
  posts: Array<{ user_ids: string[] }>;
  postFailure: { status: number; code: string } | null;
  directoryFails: boolean;
  postAborts: boolean;
  memberCount: number;
}

async function addMembersFixture(page: Page, opts: { role?: 'owner' | 'admin' | 'member'; addPolicy?: 'admins' } = {}): Promise<Server> {
  const server: Server = { directory: [], posts: [], postFailure: null, directoryFails: false, postAborts: false, memberCount: 8 };
  await installChatFixture(page, { roomRole: opts.role ?? 'member' });
  const room = () => ({
    id: 'ui-design', workspace_id: 'ui-workspace', type: 'group' as const, name: 'Design studio', description: null,
    avatar_attachment_id: null, avatar: null, created_by: me.id, settings: opts.addPolicy ? { who_can_add_members: opts.addPolicy } : {},
    last_seq: 40, member_count: server.memberCount, last_message_at: message(40).created_at,
  });
  const item = (): RoomListItem => ({ room: room(), my_role: opts.role ?? 'member', other_user: null, last_message: message(40), unread_count: 0, muted: false });
  await page.route(/\/api\/v1\/rooms\/ui-design$/, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { data: { ...item(), members: [me] } } })
    : route.fallback());
  await page.route(/\/api\/v1\/rooms\/ui-design\/members$/, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { user_ids: string[] };
    server.posts.push(body);
    if (server.postAborts) return route.abort('failed');
    if (server.postFailure) return route.fulfill({ status: server.postFailure.status, json: { error: { code: server.postFailure.code, message: 'Synthetic' } } });
    server.memberCount += body.user_ids.length;
    return route.fulfill({ json: { data: { added: body.user_ids.length, already: 0 } } });
  });
  await page.route(/\/api\/v1\/directory\?/, route => {
    const url = new URL(route.request().url());
    server.directory.push(`${url.searchParams.get('q')}|${url.searchParams.get('room_id')}|${url.searchParams.get('cursor')}`);
    if (server.directoryFails) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic' } } });
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const all = people.filter(p => q === '' || p.display_name.toLowerCase().includes(q) || p.username.includes(q))
      .map(p => ({ ...p, in_room: alreadyIn.has(p.id) }));
    const start = Number(url.searchParams.get('cursor') || 0);
    const page50 = all.slice(start, start + 50);
    return route.fulfill({ json: { data: { members: page50, next_cursor: start + 50 < all.length ? String(start + 50) : null } } });
  });
  return server;
}

const menuToggle = (page: Page) => page.locator('.bc-room-tools > summary');
const item = (page: Page) => page.getByTestId('room-add-members-menu');
const dialog = (page: Page) => page.getByTestId('add-members-dialog');
async function open(page: Page) {
  await page.goto('/rooms/ui-design');
  await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
  await menuToggle(page).click();
  await item(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId('add-members-row-p2')).toBeVisible();
}

test.describe('FR-ROOM-004 / DEC-096 add members to a group', () => {
  test('TC-WEB-ADDMEM-001 menu item: any member by default; who_can_add_members=admins hides it from members, not admins; DMs never', async ({ page, browser }) => {
    await addMembersFixture(page);
    await page.goto('/rooms/ui-design');
    await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
    await menuToggle(page).click();
    await expect(item(page)).toBeVisible();

    const context = await browser.newContext();
    const locked = await context.newPage();
    await addMembersFixture(locked, { role: 'member', addPolicy: 'admins' });
    await locked.goto('/rooms/ui-design');
    await menuToggle(locked).click();
    await expect(locked.locator('.bc-room-tools-menu')).toBeVisible();
    await expect(item(locked)).toHaveCount(0);

    const admin = await context.newPage();
    await addMembersFixture(admin, { role: 'admin', addPolicy: 'admins' });
    await admin.goto('/rooms/ui-design');
    await menuToggle(admin).click();
    await expect(item(admin)).toBeVisible();

    const dm = await context.newPage();
    await addMembersFixture(dm, { role: 'owner' });
    await dm.goto('/rooms/ui-direct');
    await expect(dm.locator('.bc-chat-header')).not.toContainText('Design studio');
    await menuToggle(dm).click();
    await expect(dm.locator('.bc-room-tools-menu')).toBeVisible();
    await expect(item(dm)).toHaveCount(0);
    await context.close();
  });

  test('TC-WEB-ADDMEM-002 type-to-search narrows the list (server-side q + room_id), people already inside are disabled with a badge', async ({ page }) => {
    const server = await addMembersFixture(page);
    await open(page);
    expect(server.directory[0]).toBe('|ui-design|');

    const already = page.getByTestId('add-members-row-p1');
    await expect(already).toContainText('อยู่ในกลุ่มแล้ว');
    await expect(already.locator('input')).toBeDisabled();
    await expect(already.locator('input')).toBeChecked();

    await page.getByTestId('add-members-search').fill('min');
    await expect(page.getByTestId('add-members-row-p3')).toBeVisible();
    await expect(page.getByTestId('add-members-row-p2')).toHaveCount(0);
    expect(server.directory.at(-1)).toBe('min|ui-design|');

    await page.getByTestId('add-members-search').fill('zzzz');
    await expect(page.getByTestId('add-members-empty')).toContainText('zzzz');
  });

  test('TC-WEB-ADDMEM-003 pick several (selection survives a new search), submit POSTs exactly those ids, dialog closes with a status and focus returns', async ({ page }) => {
    const server = await addMembersFixture(page);
    await open(page);
    await expect(page.getByTestId('add-members-submit')).toBeDisabled();

    await page.getByTestId('add-members-row-p2').click();
    await page.getByTestId('add-members-search').fill('anna');
    await expect(page.getByTestId('add-members-row-p4')).toBeVisible();
    await page.getByTestId('add-members-row-p4').click();
    await expect(page.getByTestId('add-members-count')).toContainText('เลือกแล้ว 2 คน');
    await expect(page.getByTestId('add-members-submit')).toHaveText('เพิ่ม 2 คน');

    await page.getByTestId('add-members-submit').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(server.posts).toEqual([{ user_ids: ['ui-p2', 'ui-p4'] }]);
    await expect(page.getByRole('status').filter({ hasText: 'เพิ่มสมาชิกเข้ากลุ่มแล้ว 2 คน' })).toBeVisible();
    await expect(menuToggle(page)).toBeFocused();
    await expect(page.locator('.bc-chat-header')).toContainText('10 members');
  });

  test('TC-WEB-ADDMEM-004 ROOM_FULL / network / 403 errors keep the dialog and the selection; retry succeeds', async ({ page }) => {
    const server = await addMembersFixture(page);
    await open(page);
    await page.getByTestId('add-members-row-p2').click();

    server.postFailure = { status: 422, code: 'ROOM_FULL' };
    await page.getByTestId('add-members-submit').click();
    await expect(page.getByTestId('add-members-error')).toHaveText('กลุ่มเต็มแล้ว ไม่สามารถเพิ่มสมาชิกได้');
    await expect(page.getByTestId('add-members-count')).toContainText('เลือกแล้ว 1 คน');

    server.postFailure = null;
    server.postAborts = true;
    await page.getByTestId('add-members-submit').click();
    await expect(page.getByTestId('add-members-error')).toHaveText('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
    server.postAborts = false;

    server.postFailure = { status: 403, code: 'ROOM_FORBIDDEN' };
    await page.getByTestId('add-members-submit').click();
    await expect(page.getByTestId('add-members-error')).toContainText('ไม่มีสิทธิ์');

    server.postFailure = null;
    await page.getByTestId('add-members-submit').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(server.posts).toHaveLength(4);
  });

  test('TC-WEB-ADDMEM-005 list load error is retryable; "load more" pages the directory; Escape closes', async ({ page }) => {
    const server = await addMembersFixture(page);
    server.directoryFails = true;
    await page.goto('/rooms/ui-design');
    await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
    await menuToggle(page).click();
    await item(page).click();
    await expect(page.getByTestId('add-members-load-error')).toBeVisible();
    server.directoryFails = false;
    await page.getByTestId('add-members-load-error').getByRole('button').click();
    await expect(page.getByTestId('add-members-row-p2')).toBeVisible();

    await expect(page.getByTestId('add-members-more')).toBeVisible();
    await expect(page.getByTestId('add-members-row-p60')).toHaveCount(0);
    await page.getByTestId('add-members-more').click();
    await expect(page.getByTestId('add-members-row-p60')).toBeAttached();
    expect(server.directory.at(-1)).toBe('|ui-design|50');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('TC-WEB-ADDMEM-006 at most 100 people per request: once 100 are picked every other checkbox is disabled with a note', async ({ page }) => {
    const server = await addMembersFixture(page);
    await open(page);
    for (let n = 2; n <= 50; n++) await page.getByTestId(`add-members-row-p${n}`).click();
    await page.getByTestId('add-members-more').click();
    await expect(page.getByTestId('add-members-row-p100')).toBeAttached();
    for (let n = 51; n <= 100; n++) await page.getByTestId(`add-members-row-p${n}`).click();
    await page.getByTestId('add-members-more').click();
    await expect(page.getByTestId('add-members-row-p101')).toBeAttached();
    await page.getByTestId('add-members-row-p101').click();
    await expect(page.getByTestId('add-members-count')).toContainText('เลือกแล้ว 100 คน');
    await expect(page.getByTestId('add-members-limit')).toBeVisible();
    await expect(page.getByTestId('add-members-row-p102').locator('input')).toBeDisabled();
    await expect(page.getByTestId('add-members-row-p101').locator('input')).toBeEnabled();

    await page.getByTestId('add-members-row-p101').click();
    await expect(page.getByTestId('add-members-row-p102').locator('input')).toBeEnabled();
    await page.getByTestId('add-members-submit').click();
    await expect(dialog(page)).toHaveCount(0);
    expect(server.posts[0].user_ids).toHaveLength(99);
  });

  test('TC-WEB-ADDMEM-008 the timeline says who was added: "{actor} added {name, name}", actor left out, old id-only rows fall back to a count', async ({ page }) => {
    await addMembersFixture(page);
    const system = (seq: number, sender: typeof me, system_event: Record<string, unknown>) => ({
      ...message(seq), type: 'system' as const, body: null, sender, sender_id: sender.id, system_event,
    });
    const rows = [
      system(41, me, { event: 'member_added', members: [{ id: 'ui-p2', display_name: 'Somchai Wong' }, { id: 'ui-p4', display_name: 'Anna Lee' }, { id: 'ui-p3', display_name: 'Minnie Park' }] }),
      system(42, me, { event: 'member_added', members: [{ id: me.id, display_name: 'Alex Morgan' }, { id: 'ui-p5', display_name: 'Person 05' }] }),
      system(43, me, { event: 'member_added', user_ids: ['ui-p6', 'ui-p7'] }),
    ];
    await page.route(/\/api\/v1\/rooms\/ui-design\/messages(\?|$)/, route => route.request().method() === 'GET'
      ? route.fulfill({ json: { data: { messages: rows, has_more_before: false, has_more_after: false } } })
      : route.fallback());
    await page.goto('/rooms/ui-design');
    await expect(page.getByText('Alex Morgan added Somchai Wong, Anna Lee, Minnie Park', { exact: true })).toBeVisible();
    await expect(page.getByText('Alex Morgan added Person 05', { exact: true })).toBeVisible();
    await expect(page.getByText('Alex Morgan added 2 members', { exact: true })).toBeVisible();
  });

  for (const { width, height, name } of [
    { width: 390, height: 844, name: '390' },
    { width: 360, height: 740, name: '360x740' },
    { width: 320, height: 568, name: '320x568' },
    { width: 844, height: 390, name: '844x390' },
    { width: 390, height: 380, name: '390x380-keyboard' },
    { width: 1280, height: 800, name: '1280' },
  ]) {
    test(`TC-WEB-ADDMEM-007 dialog geometry, 44px footer targets and screenshot ${width}x${height}`, async ({ page }) => {
      await mkdir(shots, { recursive: true });
      await page.setViewportSize({ width, height });
      await addMembersFixture(page);
      await open(page);
      await page.getByTestId('add-members-row-p2').click();
      await page.getByTestId('add-members-row-p3').click();
      const box = (await dialog(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(Math.abs(box.y - (height - box.y - box.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(box.x - (width - box.x - box.width))).toBeLessThanOrEqual(1);
      const footerButtons = dialog(page).locator('.bc-ae-actions > button');
      await expect(footerButtons).toHaveCount(2);
      for (const button of await footerButtons.all()) {
        const buttonBox = (await button.boundingBox())!;
        expect(buttonBox.height).toBeGreaterThanOrEqual(44);
        expect(buttonBox.y).toBeGreaterThanOrEqual(box.y);
        expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(height + 0.5);
        await button.click({ trial: true });
      }
      if (width <= 520 || height <= 520) {
        expect(await page.getByTestId('add-members-search').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
        await expect(page.getByTestId('add-members-search')).not.toBeFocused();
      }
      await page.screenshot({ path: `${shots}/picker-${name}.png` });
      await page.getByTestId('add-members-search').fill('min');
      await expect(page.getByTestId('add-members-row-p2')).toHaveCount(0);
      await page.screenshot({ path: `${shots}/picker-search-${name}.png` });
    });
  }
});
