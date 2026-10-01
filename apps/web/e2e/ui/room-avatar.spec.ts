import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RoomListItem, UserAvatar } from '@banana-chat/shared';
import { installChatFixture, me, message } from './fixtures';

/**
 * FR-PROF-008 / DEC-090 — group photo (still or animated GIF) set by a room
 * owner/admin and shown to everyone. Everything is synthetic: API, object
 * storage PUTs and images are answered by page.route; nothing real is touched.
 */
const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/room-avatar-shots';
const assets = resolve(import.meta.dirname, 'assets');
const file = (name: string) => readFile(resolve(assets, name));
const peerUser = { id: 'ui-peer', username: 'ui-peer', display_name: 'มินตรา Chen', avatar_attachment_id: null };

const photo = (name: string, animated = false): UserAvatar => ({
  sm: `/ui-avatars/${name}-sm.png`, md: `/ui-avatars/${name}-md.png`, animated: animated ? `/ui-avatars/${name}.gif` : null,
});

interface UploadCall { kind: string; filename: string; mime_type: string; size_bytes: number }

/** The "server": shared between browser contexts so a second member really sees the first one's change. */
function serverState(avatar: UserAvatar | null = null) {
  return {
    avatar,
    name: 'Design studio · ออกแบบ',
    uploads: [] as UploadCall[],
    puts: [] as { contentType: string | undefined; body: Buffer }[],
    patches: [] as Array<{ avatar_attachment_id?: string | null }>,
    completes: [] as string[],
    patchFailure: null as { status: number; code: string } | null,
    putFails: false,
  };
}
type Server = ReturnType<typeof serverState>;

interface Options { role?: 'owner' | 'admin' | 'member'; locale?: 'th' | 'en'; forwarding?: boolean }

async function roomAvatarFixture(page: Page, server: Server, opts: Options = {}) {
  const role = opts.role ?? 'owner';
  const chat = await installChatFixture(page, { forwarding: opts.forwarding, roomRole: role });
  const [peerPng, mePng, gif] = await Promise.all([file('peer-avatar.png'), file('me-avatar.png'), file('avatar-anim.gif')]);

  await page.route('**/ui-avatars/**', route => {
    const url = route.request().url();
    if (url.includes('broken')) return route.fulfill({ status: 404, body: '' });
    if (url.endsWith('.gif')) return route.fulfill({ contentType: 'image/gif', body: gif });
    return route.fulfill({ contentType: 'image/png', body: url.includes('peer') ? peerPng : mePng });
  });
  await page.route('**/ui-storage/**', async route => {
    const request = route.request();
    server.puts.push({ contentType: await request.headerValue('content-type') ?? undefined, body: request.postDataBuffer() ?? Buffer.alloc(0) });
    if (server.putFails) return route.abort('failed');
    return route.fulfill({ status: 200, headers: { ETag: '"etag-1"' }, body: '' });
  });
  await page.route('**/api/v1/uploads', async route => {
    const input = route.request().postDataJSON() as UploadCall;
    server.uploads.push(input);
    const id = `${input.mime_type === 'image/gif' ? 'att-gif' : 'att-new'}-${server.uploads.length}`;
    return route.fulfill({ json: { data: { attachment_id: id, put_url: `${new URL(route.request().url()).origin}/ui-storage/${id}`, multipart: null, headers: { 'Content-Type': input.mime_type }, expires_at: '2099-01-01T00:00:00Z' } } });
  });
  await page.route('**/api/v1/uploads/*/complete', route => {
    const id = route.request().url().split('/').at(-2)!;
    server.completes.push(id);
    return route.fulfill({ json: { data: { attachment: { id, kind: 'avatar', status: 'ready' } } } });
  });

  const room = () => ({
    id: 'ui-design', workspace_id: 'ui-workspace', type: 'group' as const, name: server.name, description: null,
    avatar_attachment_id: server.avatar ? 'att-group' : null, avatar: server.avatar,
    created_by: me.id, last_seq: 40, member_count: 8, last_message_at: message(40).created_at,
  });
  const rooms = (): RoomListItem[] => [
    { room: room(), my_role: role, other_user: null, last_message: message(40), unread_count: 0, muted: false },
    { room: { ...room(), id: 'ui-direct', type: 'dm', name: null, member_count: 2, avatar_attachment_id: null, avatar: null }, my_role: 'member', other_user: peerUser, last_message: message(39), unread_count: 0, muted: false },
    { room: { ...room(), id: 'ui-product', name: 'Product team', avatar_attachment_id: null, avatar: null }, my_role: 'member', other_user: null, last_message: message(38), unread_count: 0, muted: false },
  ];
  await page.route(/\/api\/v1\/rooms(\?.*)?$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { data: rooms() } });
  });
  await page.route(/\/api\/v1\/rooms\/ui-design$/, route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const input = request.postDataJSON() as { avatar_attachment_id?: string | null };
      server.patches.push(input);
      if (server.patchFailure) return route.fulfill({ status: server.patchFailure.status, json: { error: { code: server.patchFailure.code, message: 'Synthetic failure', request_id: null } } });
      server.avatar = input.avatar_attachment_id ? (input.avatar_attachment_id.startsWith('att-gif') ? photo('peer', true) : photo('me')) : null;
      return route.fulfill({ json: { data: { room: { id: 'ui-design', name: server.name, description: null, avatar_attachment_id: input.avatar_attachment_id ?? null, avatar: server.avatar, settings: {}, member_count: 8 } } } });
    }
    return route.fulfill({ json: { data: { ...rooms()[0], members: [me, peerUser] } } });
  });
  if (opts.locale === 'en') {
    await page.route('**/api/v1/me', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { data: { user: { ...me, locale: 'en', is_system_admin: false }, settings: { locale: 'en', timezone: 'Asia/Bangkok', notification: null } } } })
      : route.fallback());
  }
  return { ...chat, files: { gif } };
}

const editor = (page: Page) => page.getByTestId('avatar-editor');
const headerButton = (page: Page) => page.getByTestId('group-photo-button');
const menuToggle = (page: Page) => page.locator('.bc-room-tools > summary');
const menuItem = (page: Page) => page.getByTestId('room-photo-menu');
const rowPhoto = (page: Page, name: string) => page.locator('.bc-room-row', { hasText: name }).getByTestId('avatar-photo');

async function openRoom(page: Page) {
  await page.goto('/rooms/ui-design');
  await expect(page.locator('.bc-chat-header')).toContainText('Design studio');
}
async function openFromMenu(page: Page, title = 'เปลี่ยนรูปกลุ่ม', item = 'เปลี่ยนรูปกลุ่ม') {
  await menuToggle(page).click();
  await menuItem(page).filter({ hasText: item }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole('heading', { name: title })).toBeVisible();
  await editor(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
}
async function choose(page: Page, name: string, mimeType: string, buffer?: Buffer) {
  await page.getByTestId('avatar-file-input').setInputFiles({ name, mimeType, buffer: buffer ?? await file(name) });
}

/** A photo must be a true circle: square box, 50% radius, exactly inside its tile. */
async function expectCirclePhoto(img: Locator) {
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  const tile = (await img.locator('xpath=..').boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
  expect(box.width).toBeGreaterThan(10);
  expect(Math.abs(box.x - tile.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.width - tile.width)).toBeLessThanOrEqual(0.5);
  const style = await img.evaluate(el => {
    const parent = getComputedStyle(el.parentElement!);
    return { fit: getComputedStyle(el).objectFit, radius: parent.borderTopLeftRadius, overflow: parent.overflow, loaded: el.classList.contains('is-loaded') };
  });
  expect(style).toEqual({ fit: 'cover', radius: '50%', overflow: 'hidden', loaded: true });
}

async function expectDialogFits(page: Page) {
  const viewport = page.viewportSize()!;
  const box = (await editor(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="avatar-editor"]')!;
    return { page: document.documentElement.scrollWidth - window.innerWidth, dialog: dialog.scrollWidth - dialog.clientWidth };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.dialog).toBeLessThanOrEqual(0);
  for (const control of await editor(page).locator('button:visible').all()) {
    const b = (await control.boundingBox())!;
    expect(b.height, await control.textContent() ?? '').toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

test.describe('FR-PROF-008 group photo', () => {
  test('TC-WEB-ROOMAVATAR-001 owner and admin get the menu item and a header button; a plain member gets neither (and DMs never do)', async ({ page, browser }) => {
    for (const role of ['owner', 'admin'] as const) {
      const context = await browser.newContext();
      const other = await context.newPage();
      await roomAvatarFixture(other, serverState(), { role });
      await openRoom(other);
      await expect(headerButton(other)).toBeVisible();
      await expect(headerButton(other)).toHaveAccessibleName('เปลี่ยนรูปกลุ่ม');
      await expect(headerButton(other)).toHaveAttribute('aria-haspopup', 'dialog');
      await menuToggle(other).click();
      await expect(menuItem(other)).toHaveText('เปลี่ยนรูปกลุ่ม');
      await context.close();
    }
    await roomAvatarFixture(page, serverState(), { role: 'member' });
    await openRoom(page);
    await expect(page.locator('.bc-chat-identity .bc-avatar')).toBeVisible();
    await expect(headerButton(page)).toHaveCount(0);
    await expect(page.locator('.bc-chat-identity button')).toHaveCount(0);
    await menuToggle(page).click();
    await expect(page.locator('.bc-room-tools-menu')).toBeVisible();
    await expect(menuItem(page)).toHaveCount(0);
    // a DM never offers it, even for an owner of the other room
    const dm = await browser.newContext();
    const dmPage = await dm.newPage();
    await roomAvatarFixture(dmPage, serverState(), { role: 'owner' });
    await dmPage.goto('/rooms/ui-direct');
    await expect(dmPage.locator('.bc-chat-header')).toContainText('Chen');
    await expect(headerButton(dmPage)).toHaveCount(0);
    await dmPage.locator('.bc-room-tools > summary').click();
    await expect(menuItem(dmPage)).toHaveCount(0);
    await dm.close();
  });

  test('TC-WEB-ROOMAVATAR-002 a still is cropped and saved via upload → PUT → complete → PATCH /rooms/{id}; header and list show the photo', async ({ page }) => {
    const server = serverState();
    await roomAvatarFixture(page, server);
    await openRoom(page);
    await expect(headerButton(page).locator('.bc-avatar')).toHaveText('DS');
    await expect(headerButton(page).getByTestId('avatar-photo')).toHaveCount(0);
    await openFromMenu(page);
    await expect(editor(page)).toHaveAttribute('data-target', 'room');
    await expect(editor(page)).toContainText('สมาชิกทุกคนในกลุ่มจะเห็นรูปนี้');
    await expect(editor(page)).toContainText('กลุ่มนี้ยังไม่มีรูป');
    await expect(page.getByTestId('avatar-circle').locator('.bc-avatar')).toHaveText('DS'); // group initials, not mine
    await expect(page.getByTestId('avatar-choose')).toBeFocused();
    await expect(page.getByTestId('avatar-remove')).toHaveCount(0);
    await choose(page, 'avatar-landscape.png', 'image/png');
    await expect(page.getByTestId('avatar-crop-image')).toBeVisible();
    await page.getByTestId('avatar-zoom').fill('1.5');
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    // focus returns to the menu toggle that opened it
    await expect(menuToggle(page)).toBeFocused();

    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0]).toMatchObject({ kind: 'avatar', mime_type: 'image/webp', filename: 'avatar.webp' });
    expect(server.puts[0]!.body.length).toBe(server.uploads[0]!.size_bytes);
    expect(server.completes).toEqual(['att-new-1']);
    expect(server.patches).toEqual([{ avatar_attachment_id: 'att-new-1' }]);
    await expectCirclePhoto(headerButton(page).getByTestId('avatar-photo'));
    await expect(headerButton(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
    await expectCirclePhoto(rowPhoto(page, 'Design studio'));
    // other rooms are untouched: DM keeps the peer, the other group keeps initials
    await expect(page.locator('.bc-room-row', { hasText: 'Product team' }).locator('.bc-avatar')).toHaveText('PT');
    await expect(page.locator('.bc-room-row', { hasText: 'Product team' }).getByTestId('avatar-photo')).toHaveCount(0);
  });

  test('TC-WEB-ROOMAVATAR-003 a GIF skips the canvas: original bytes uploaded, centre-crop hint, animated in the header', async ({ page }) => {
    const server = serverState();
    const api = await roomAvatarFixture(page, server);
    await openRoom(page);
    await headerButton(page).click();
    await expect(editor(page)).toBeVisible();
    await choose(page, 'avatar-anim.gif', 'image/gif');
    await expect(page.getByTestId('avatar-gif-preview')).toBeVisible();
    await expect(page.getByTestId('avatar-crop-image')).toHaveCount(0);
    await expect(page.getByTestId('avatar-gif-hint')).toHaveText('GIF จะถูกครอปตรงกลางอัตโนมัติ เพื่อให้ภาพเคลื่อนไหวคงอยู่');
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.uploads[0]).toMatchObject({ kind: 'avatar', mime_type: 'image/gif', filename: 'avatar-anim.gif', size_bytes: api.files.gif.length });
    expect(server.puts[0]!.body.equals(api.files.gif)).toBe(true);
    expect(server.patches).toEqual([{ avatar_attachment_id: 'att-gif-1' }]);
    await expect(headerButton(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/peer.gif');
    // focus returns to the header button it was opened from
    await expect(headerButton(page)).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(headerButton(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/peer-sm.png');
  });

  test('TC-WEB-ROOMAVATAR-004 remove asks first, then PATCHes null and falls back to the group initials', async ({ page }) => {
    const server = serverState(photo('peer'));
    await roomAvatarFixture(page, server);
    await openRoom(page);
    await expectCirclePhoto(headerButton(page).getByTestId('avatar-photo'));
    await expectCirclePhoto(rowPhoto(page, 'Design studio'));
    await openFromMenu(page);
    await expect(page.getByTestId('avatar-circle').getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/peer-md.png');
    await page.getByTestId('avatar-remove').click();
    const confirm = page.getByTestId('avatar-remove-confirm');
    await expect(confirm).toContainText('ลบรูปกลุ่ม?');
    await expect(confirm).toContainText('ตัวอักษรย่อของชื่อกลุ่ม');
    await expect(confirm.getByRole('button', { name: 'เก็บไว้' })).toBeFocused();
    await confirm.getByRole('button', { name: 'เก็บไว้' }).click();
    expect(server.patches).toHaveLength(0);
    await page.getByTestId('avatar-remove').click();
    await page.getByTestId('avatar-remove-confirm-button').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.patches).toEqual([{ avatar_attachment_id: null }]);
    await expect(headerButton(page).getByTestId('avatar-photo')).toHaveCount(0);
    await expect(headerButton(page).locator('.bc-avatar')).toHaveText('DS');
    await expect(rowPhoto(page, 'Design studio')).toHaveCount(0);
  });

  test('TC-WEB-ROOMAVATAR-005 wrong type, too large, AVATAR_INVALID, a revoked role and network failures are human errors; the dialog stays usable', async ({ page }) => {
    const server = serverState();
    await roomAvatarFixture(page, server);
    await openRoom(page);
    await openFromMenu(page);
    const error = page.getByTestId('avatar-error');
    await choose(page, 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    await expect(error).toHaveText('ใช้ได้เฉพาะไฟล์ JPG, PNG, WebP หรือ GIF');
    await choose(page, 'huge.png', 'image/png', Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(error).toHaveText('รูปนี้ใหญ่เกิน 5 MB ลองย่อรูปหรือเลือกรูปอื่น');
    await expect(page.getByTestId('avatar-save')).toBeDisabled();
    expect(server.uploads).toHaveLength(0);
    await choose(page, 'avatar-anim.gif', 'image/gif');
    server.putFails = true;
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
    server.putFails = false;
    server.patchFailure = { status: 422, code: 'AVATAR_INVALID' };
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('ตั้งรูปนี้ไม่ได้ กรุณาอัปโหลดใหม่อีกครั้ง');
    server.patchFailure = { status: 403, code: 'ROOM_FORBIDDEN' };
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('คุณไม่มีสิทธิ์เปลี่ยนรูปนี้แล้ว');
    await expect(page.getByTestId('avatar-save')).toBeEnabled();
    server.patchFailure = null;
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.patches.at(-1)).toEqual({ avatar_attachment_id: 'att-gif-4' });
  });

  test('TC-WEB-ROOMAVATAR-006 a second member sees a photo change without reload (room.updated and the system message), and the list follows too', async ({ page, browser }) => {
    const server = serverState();
    // member B in a separate browser context, sharing the same "server"
    const context = await browser.newContext();
    const member = await context.newPage();
    const chat = await roomAvatarFixture(member, server, { role: 'member' });
    await openRoom(member);
    await expect(member.locator('.bc-chat-identity .bc-avatar')).toHaveText('DS');
    await expect(member.locator('.bc-chat-identity [data-testid=avatar-photo]')).toHaveCount(0);

    // owner A changes it
    await roomAvatarFixture(page, server);
    await openRoom(page);
    await openFromMenu(page);
    await choose(page, 'avatar-landscape.png', 'image/png');
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(server.avatar).not.toBeNull();

    // EVT-002 on the private room channel — URL-free, so the client refetches
    await chat.emit('room.updated', { room_id: 'ui-design' });
    await expect(member.locator('.bc-chat-identity [data-testid=avatar-photo]')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
    await expect(rowPhoto(member, 'Design studio')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
    await expectCirclePhoto(member.locator('.bc-chat-identity [data-testid=avatar-photo]'));
    // still inert for a plain member
    await expect(headerButton(member)).toHaveCount(0);

    // removal arrives via the durable twin: the system message on the room channel
    server.avatar = null;
    await chat.emit('message.created', { message: { ...message(41), type: 'system', body: null, sender_id: me.id, sender: me, system_event: { event: 'room_avatar_changed' } } });
    await expect(member.locator('.bc-chat-identity [data-testid=avatar-photo]')).toHaveCount(0);
    await expect(rowPhoto(member, 'Design studio')).toHaveCount(0);
    await expect(member.locator('[data-seq="41"]')).toContainText('Alex Morgan changed the group photo');
    await context.close();
  });

  test('TC-WEB-ROOMAVATAR-007 keyboard only: summary → item → dialog, Tab stays inside, Escape returns focus to the opener', async ({ page }) => {
    await roomAvatarFixture(page, serverState());
    await openRoom(page);
    await menuToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(menuItem(page)).toBeVisible();
    await menuItem(page).focus();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeVisible();
    await expect(page.getByTestId('avatar-choose')).toBeFocused();
    // modal: focus never lands on the chat behind it, however far we Tab
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('.bc-chat') ?? null)).toBeNull();
    }
    await page.getByTestId('avatar-choose').focus();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(menuToggle(page)).toBeFocused();
    // header button is reachable and activates with Enter / Space, then Escape returns to it
    await headerButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(headerButton(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(editor(page)).toBeVisible();
    await editor(page).getByRole('button', { name: 'ปิด' }).click();
    await expect(headerButton(page)).toBeFocused();
  });

  test('TC-WEB-ROOMAVATAR-008 English copy and system-message wording (room_avatar_changed, room_renamed)', async ({ page }) => {
    const chat = await roomAvatarFixture(page, serverState(photo('peer')), { locale: 'en' });
    await openRoom(page);
    await expect(headerButton(page)).toHaveAccessibleName('Change group photo');
    await openFromMenu(page, 'Change group photo', 'Change group photo');
    await expect(editor(page)).toContainText('Everyone in this group sees it');
    await page.getByTestId('avatar-remove').click();
    await expect(page.getByTestId('avatar-remove-confirm')).toContainText('Remove the group photo?');
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);

    await chat.emit('message.created', { message: { ...message(41), type: 'system', body: null, system_event: { event: 'room_avatar_changed' } } });
    await expect(page.locator('[data-seq="41"]')).toContainText('มินตรา Chen changed the group photo');
    await chat.emit('message.created', { message: { ...message(42), type: 'system', body: null, system_event: { event: 'room_renamed', name: 'Studio 2' } } });
    await expect(page.locator('[data-seq="42"]')).toContainText('มินตรา Chen renamed the room to Studio 2');
  });

  test('TC-WEB-ROOMAVATAR-009 the forward dialog lists a group with its photo and a DM with the peer photo', async ({ page }) => {
    await roomAvatarFixture(page, serverState(photo('peer')), { forwarding: true });
    await page.goto('/rooms/ui-design');
    await expect(page.locator('[data-seq="40"]')).toBeVisible();
    await page.locator('[data-seq="40"] .bc-message-actions-toggle').click();
    await page.getByTestId('message-actions').getByRole('button', { name: 'ส่งต่อ', exact: true }).click();
    const dialog = page.getByTestId('forward-dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.locator('.bc-forward-room', { hasText: 'Design studio' });
    await expectCirclePhoto(row.getByTestId('avatar-photo'));
    await expect(dialog.locator('.bc-forward-room', { hasText: 'Product team' }).getByTestId('avatar-photo')).toHaveCount(0);
  });

  for (const [width, height] of [[360, 740], [1280, 800]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`TC-WEB-ROOMAVATAR-010 geometry + screenshots ${width}x${height} ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await roomAvatarFixture(page, serverState(photo('peer')));
        await openRoom(page);
        await mkdir(shots, { recursive: true });
        const button = headerButton(page);
        await expectCirclePhoto(button.getByTestId('avatar-photo'));
        // the header button keeps its avatar a circle (buttons.css must not stretch it)
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
        const inner = (await button.locator('.bc-avatar').boundingBox())!;
        expect(Math.abs(inner.width - inner.height)).toBeLessThanOrEqual(0.5);
        expect(inner.width).toBeLessThanOrEqual(44);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `${shots}/header-${width}-${scheme}.png` });

        await menuToggle(page).click();
        await expect(menuItem(page)).toBeVisible();
        const item = (await menuItem(page).boundingBox())!;
        expect(item.height).toBeGreaterThanOrEqual(44);
        const menu = (await page.locator('.bc-room-tools-menu').boundingBox())!;
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(width + 0.5);
        await page.screenshot({ path: `${shots}/menu-${width}-${scheme}.png` });

        await menuItem(page).click();
        await expect(editor(page)).toBeVisible();
        await editor(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
        await expectCirclePhoto(page.getByTestId('avatar-circle').getByTestId('avatar-photo'));
        await expectDialogFits(page);
        await page.screenshot({ path: `${shots}/editor-current-${width}-${scheme}.png` });
        await choose(page, 'avatar-landscape.png', 'image/png');
        await expect(page.getByTestId('avatar-crop-image')).toBeVisible();
        await expectDialogFits(page);
        await page.screenshot({ path: `${shots}/editor-crop-${width}-${scheme}.png` });
        await page.keyboard.press('Escape');
        await expect(editor(page)).toHaveCount(0);
        await page.screenshot({ path: `${shots}/list-${width}-${scheme}.png` });
      });
    }
  }
});
