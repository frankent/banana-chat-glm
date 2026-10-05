import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { UserAvatar, WorkspaceSummary } from '@banana-chat/shared';
import { installChatFixture } from './fixtures';

/**
 * FR-WS-004 / DEC-093 — a workspace owner/admin renames the workspace and
 * changes its photo; everyone sees it. API, storage PUTs and images are all
 * synthetic (page.route); nothing real is touched.
 */
const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/ws-info-shots';
const assets = resolve(import.meta.dirname, 'assets');
const photo = (name: string): UserAvatar => ({ sm: `/ui-avatars/${name}-sm.png`, md: `/ui-avatars/${name}-md.png`, animated: null });

function serverState(avatar: UserAvatar | null = null) {
  return {
    name: 'Banana Studio',
    avatar,
    patches: [] as Array<{ name?: string; avatar_attachment_id?: string | null }>,
    workspaceHeaders: [] as Array<string | undefined>,
    uploads: [] as Array<{ kind: string }>,
    patchFailure: null as { status: number; code: string } | null,
  };
}
type Server = ReturnType<typeof serverState>;

async function wsFixture(page: Page, server: Server, opts: { role?: WorkspaceSummary['role']; locale?: 'th' | 'en'; systemAdmin?: boolean } = {}) {
  await installChatFixture(page, { systemAdmin: opts.systemAdmin });
  const [mePng, peerPng] = await Promise.all([readFile(resolve(assets, 'me-avatar.png')), readFile(resolve(assets, 'peer-avatar.png'))]);
  await page.route('**/ui-avatars/**', route => route.fulfill({ contentType: 'image/png', body: route.request().url().includes('peer') ? peerPng : mePng }));
  await page.route('**/ui-storage/**', route => route.fulfill({ status: 200, headers: { ETag: '"etag-1"' }, body: '' }));
  await page.route('**/api/v1/uploads', route => {
    const input = route.request().postDataJSON() as { kind: string; mime_type: string };
    server.uploads.push({ kind: input.kind });
    const id = `att-ws-${server.uploads.length}`;
    return route.fulfill({ json: { data: { attachment_id: id, put_url: `${new URL(route.request().url()).origin}/ui-storage/${id}`, multipart: null, headers: { 'Content-Type': input.mime_type }, expires_at: '2099-01-01T00:00:00Z' } } });
  });
  await page.route('**/api/v1/uploads/*/complete', route => route.fulfill({ json: { data: { attachment: { id: route.request().url().split('/').at(-2)!, kind: 'avatar', status: 'ready' } } } }));

  const identity = () => ({ id: 'ui-workspace', slug: 'ui-studio', name: server.name, status: 'active', avatar_attachment_id: server.avatar ? 'att-ws-current' : null, avatar: server.avatar });
  await page.route('**/api/v1/me/workspaces', route => route.fulfill({ json: { data: [{ workspace: identity(), role: opts.role ?? 'owner', unread_rooms_count: 2, total_unread: 128 }] } }));
  await page.route('**/api/v1/workspace', route => {
    const request = route.request();
    if (request.method() !== 'PATCH') return route.fallback();
    server.workspaceHeaders.push(request.headers()['x-workspace-id']);
    const input = request.postDataJSON() as { name?: string; avatar_attachment_id?: string | null };
    server.patches.push(input);
    if (server.patchFailure) return route.fulfill({ status: server.patchFailure.status, json: { error: { code: server.patchFailure.code, message: 'Synthetic failure', request_id: null } } });
    if (input.name !== undefined) server.name = input.name;
    if (input.avatar_attachment_id !== undefined) server.avatar = input.avatar_attachment_id === null ? null : photo('peer');
    return route.fulfill({ json: { data: { workspace: identity() } } });
  });
  if (opts.locale === 'en') {
    await page.route('**/api/v1/me', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { data: { user: { id: 'ui-me', username: 'ui-tester', display_name: 'Alex Morgan', avatar_attachment_id: null, locale: 'en', is_system_admin: opts.systemAdmin ?? false }, settings: { locale: 'en', timezone: 'Asia/Bangkok', notification: null } } } })
      : route.fallback());
  }
}

const accountMenu = (page: Page) => page.getByRole('button', { name: 'Account menu' });
const renameItem = (page: Page) => page.getByTestId('ws-rename-menu');
const photoItem = (page: Page) => page.getByTestId('ws-photo-menu');
const renameDialog = (page: Page) => page.getByTestId('ws-rename-dialog');
const editor = (page: Page) => page.getByTestId('avatar-editor');
const switcher = (page: Page) => page.getByLabel('Workspace', { exact: true });
const sidebarAvatar = (page: Page) => page.locator('.bc-workspace .bc-avatar');

async function openApp(page: Page) {
  await page.goto('/rooms/ui-design');
  await expect(switcher(page)).toContainText('Banana');
}

async function expectDialogFits(page: Page, dialog: Locator) {
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
  const overflow = await page.evaluate(() => {
    const open = document.querySelector('dialog[open]')!;
    return { page: document.documentElement.scrollWidth - window.innerWidth, dialog: open.scrollWidth - open.clientWidth };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.dialog).toBeLessThanOrEqual(0);
  for (const control of await dialog.locator('button:visible').all()) {
    const b = (await control.boundingBox())!;
    expect(b.height, await control.textContent() ?? '').toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

test.describe('FR-WS-004 workspace name and photo', () => {
  test('TC-WEB-WSINFO-001 owner, admin and system admin get both menu items; a plain member gets neither', async ({ browser }) => {
    const cases: Array<{ role: WorkspaceSummary['role']; systemAdmin?: boolean; visible: boolean }> = [
      { role: 'owner', visible: true }, { role: 'admin', visible: true }, { role: 'member', visible: false },
      { role: 'member', systemAdmin: true, visible: true },
    ];
    for (const c of cases) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await wsFixture(page, serverState(), { role: c.role, systemAdmin: c.systemAdmin });
      await openApp(page);
      await accountMenu(page).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(renameItem(page)).toHaveCount(c.visible ? 1 : 0);
      await expect(photoItem(page)).toHaveCount(c.visible ? 1 : 0);
      if (c.visible) {
        await expect(renameItem(page)).toHaveText('เปลี่ยนชื่อ workspace');
        await expect(photoItem(page)).toHaveText('เปลี่ยนรูป workspace');
      }
      await context.close();
    }
  });

  test('TC-WEB-WSINFO-002 rename PATCHes {name} for THIS workspace; the sidebar and tab title change with no navigation or reload', async ({ page }) => {
    const server = serverState();
    await wsFixture(page, server);
    await openApp(page);
    await page.evaluate(() => { (window as unknown as { __marker: string }).__marker = 'same-document'; });
    await accountMenu(page).click();
    await renameItem(page).click();
    await expect(renameDialog(page)).toBeVisible();
    await expect(page.getByTestId('rename-input')).toHaveValue('Banana Studio');
    await page.getByTestId('rename-input').fill('  Banana Labs  ');
    await page.getByTestId('rename-save').click();
    await expect(renameDialog(page)).toHaveCount(0);
    expect(server.patches).toEqual([{ name: 'Banana Labs' }]);
    expect(server.workspaceHeaders).toEqual(['ui-studio']);
    await expect(switcher(page)).toContainText('Banana Labs');
    await expect.poll(() => page.title()).toContain('Banana Labs');
    expect(await page.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('same-document');
    await expect(page).toHaveURL(/\/rooms\/ui-design$/);
    await expect(sidebarAvatar(page)).toHaveText('BL');
    await expect(accountMenu(page)).toBeFocused();
  });

  test('TC-WEB-WSINFO-003 Save stays disabled for an unchanged or empty name and no PATCH fires', async ({ page }) => {
    const server = serverState();
    await wsFixture(page, server);
    await openApp(page);
    await accountMenu(page).click();
    await renameItem(page).click();
    const save = page.getByTestId('rename-save');
    await expect(save).toBeDisabled();
    await page.getByTestId('rename-input').fill('   ');
    await expect(save).toBeDisabled();
    await page.getByTestId('rename-input').fill('');
    await expect(save).toBeDisabled();
    await page.getByTestId('rename-input').fill('  Banana Studio ');
    await expect(save).toBeDisabled();
    await page.getByTestId('rename-input').fill('Banana Studio 2');
    await expect(save).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(renameDialog(page)).toHaveCount(0);
    expect(server.patches).toHaveLength(0);
  });

  test('TC-WEB-WSINFO-004 a revoked role (403 WS_FORBIDDEN) is a human error; the name is unchanged and the dialog stays usable', async ({ page }) => {
    const server = serverState();
    server.patchFailure = { status: 403, code: 'WS_FORBIDDEN' };
    await wsFixture(page, server);
    await openApp(page);
    await accountMenu(page).click();
    await renameItem(page).click();
    await page.getByTestId('rename-input').fill('Nope');
    await page.getByTestId('rename-save').click();
    await expect(page.getByTestId('rename-error')).toHaveText('คุณไม่มีสิทธิ์เปลี่ยนชื่อ workspace นี้แล้ว');
    await expect(page.getByTestId('rename-save')).toBeEnabled();
    await expect(switcher(page)).toContainText('Banana Studio');
    server.patchFailure = null;
    await page.getByTestId('rename-save').click();
    await expect(renameDialog(page)).toHaveCount(0);
    await expect(switcher(page)).toContainText('Nope');
  });

  test('TC-WEB-WSINFO-005 photo: upload as kind=avatar, PATCH the id, sidebar shows the photo; remove asks first, then PATCHes null and the initials return', async ({ page }) => {
    const server = serverState();
    await wsFixture(page, server);
    await openApp(page);
    await expect(sidebarAvatar(page)).toHaveText('BS');
    await expect(sidebarAvatar(page).getByTestId('avatar-photo')).toHaveCount(0);

    await accountMenu(page).click();
    await photoItem(page).click();
    await expect(editor(page)).toBeVisible();
    await expect(editor(page)).toHaveAttribute('data-target', 'workspace');
    await expect(editor(page).getByRole('heading', { name: 'เปลี่ยนรูป workspace' })).toBeVisible();
    await expect(page.getByTestId('avatar-circle').locator('.bc-avatar')).toHaveText('BS');
    await page.getByTestId('avatar-file-input').setInputFiles({ name: 'me-avatar.png', mimeType: 'image/png', buffer: await readFile(resolve(assets, 'me-avatar.png')) });
    await expect(page.getByTestId('avatar-crop-image')).toBeVisible();
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.uploads).toEqual([{ kind: 'avatar' }]);
    expect(server.patches).toEqual([{ avatar_attachment_id: 'att-ws-1' }]);
    await expect(sidebarAvatar(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/peer-sm.png');
    await page.screenshot({ path: `${shots}/photo-set.png` });

    await accountMenu(page).click();
    await photoItem(page).click();
    await page.getByTestId('avatar-remove').click();
    await expect(page.getByTestId('avatar-remove-confirm')).toContainText('ลบรูป workspace?');
    await page.getByTestId('avatar-remove-confirm-button').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.patches.at(-1)).toEqual({ avatar_attachment_id: null });
    await expect(sidebarAvatar(page).getByTestId('avatar-photo')).toHaveCount(0);
    await expect(sidebarAvatar(page)).toHaveText('BS');
  });

  test('TC-WEB-WSINFO-006 a 403 while saving the photo shows the forbidden error and leaves the photo as it was', async ({ page }) => {
    const server = serverState(photo('me'));
    await wsFixture(page, server);
    await openApp(page);
    await expect(sidebarAvatar(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
    server.patchFailure = { status: 403, code: 'WS_FORBIDDEN' };
    await accountMenu(page).click();
    await photoItem(page).click();
    await page.getByTestId('avatar-file-input').setInputFiles({ name: 'peer-avatar.png', mimeType: 'image/png', buffer: await readFile(resolve(assets, 'peer-avatar.png')) });
    await page.getByTestId('avatar-save').click();
    await expect(editor(page).getByRole('alert')).toBeVisible();
    await expect(editor(page)).toBeVisible();
    await expect(sidebarAvatar(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
  });

  test('TC-WEB-WSINFO-007 English copy', async ({ page }) => {
    await wsFixture(page, serverState(), { locale: 'en' });
    await openApp(page);
    await accountMenu(page).click();
    await expect(renameItem(page)).toHaveText('Rename workspace');
    await expect(photoItem(page)).toHaveText('Change workspace photo');
    await renameItem(page).click();
    await expect(renameDialog(page).getByRole('heading', { name: 'Rename workspace' })).toBeVisible();
    await expect(renameDialog(page).getByText('Workspace name')).toBeVisible();
  });

  for (const viewport of [{ width: 360, height: 640 }, { width: 1280, height: 800 }]) {
    test(`TC-WEB-WSINFO-008 rename dialog and photo editor fit @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await wsFixture(page, serverState());
      // phone layout hides the rail while a conversation is open; the list route keeps it
      await page.goto('/');
      await expect(switcher(page)).toContainText('Banana');
      await accountMenu(page).click();
      await renameItem(page).click();
      await expect(renameDialog(page)).toBeVisible();
      await renameDialog(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      await expectDialogFits(page, renameDialog(page));
      await page.screenshot({ path: `${shots}/rename-${viewport.width}.png` });
      await page.keyboard.press('Escape');
      await accountMenu(page).click();
      await photoItem(page).click();
      await expect(editor(page)).toBeVisible();
      await editor(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
      await expectDialogFits(page, editor(page));
      await page.screenshot({ path: `${shots}/photo-${viewport.width}.png` });
    });
  }

  test('TC-WEB-WSINFO-009 the sidebar workspace tile is a true square with initials, and a photo fills it without distortion', async ({ page }) => {
    await wsFixture(page, serverState(photo('me')));
    await openApp(page);
    const tile = (await sidebarAvatar(page).boundingBox())!;
    expect(Math.abs(tile.width - tile.height)).toBeLessThanOrEqual(0.5);
    expect(tile.width).toBeGreaterThanOrEqual(30);
    const img = sidebarAvatar(page).getByTestId('avatar-photo');
    await expect(img).toBeVisible();
    const box = (await img.boundingBox())!;
    expect(Math.abs(box.width - tile.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.height - tile.height)).toBeLessThanOrEqual(0.5);
    expect(await img.evaluate(el => getComputedStyle(el).objectFit)).toBe('cover');
    await page.screenshot({ path: `${shots}/sidebar-photo.png` });
  });
});
