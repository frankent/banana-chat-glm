import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { UserAvatar } from '@banana-chat/shared';
import { installChatFixture, me, message } from './fixtures';

/**
 * FR-PROF-006 / DEC-088 — profile photo (still or animated GIF).
 * Everything is synthetic: API, object storage PUTs and avatar images are
 * answered by page.route; no real account, upload or database is touched.
 */
const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/avatar-shots';
const assets = resolve(import.meta.dirname, 'assets');
const file = (name: string) => readFile(resolve(assets, name));

const photo = (name: string, animated = false): UserAvatar => ({
  sm: `/ui-avatars/${name}-sm.png`, md: `/ui-avatars/${name}-md.png`, animated: animated ? `/ui-avatars/${name}.gif` : null,
});

interface UploadCall { kind: string; filename: string; mime_type: string; size_bytes: number }

async function avatarFixture(page: Page, opts: { avatar?: UserAvatar | null; peerAvatar?: UserAvatar | null; processing?: boolean } = {}) {
  const chat = await installChatFixture(page);
  let myAvatar: UserAvatar | null = opts.avatar ?? null;
  let peerAvatar: UserAvatar | null = opts.peerAvatar ?? null;
  const uploads: UploadCall[] = [];
  const puts: { url: string; contentType: string | undefined; body: Buffer }[] = [];
  const patches: Array<{ avatar_attachment_id?: string | null }> = [];
  const completes: string[] = [];
  let patchFailure: { status: number; code: string } | null = null;
  let putFails = false;
  let polls = 0;
  const [peerPng, mePng, gif] = await Promise.all([file('peer-avatar.png'), file('me-avatar.png'), file('avatar-anim.gif')]);
  const user = () => ({ ...me, locale: 'th', is_system_admin: false, avatar_attachment_id: myAvatar ? 'att-current' : null, avatar: myAvatar });

  await page.route('**/ui-avatars/**', route => {
    const url = route.request().url();
    if (url.includes('broken')) return route.fulfill({ status: 404, body: '' });
    if (url.endsWith('.gif')) return route.fulfill({ contentType: 'image/gif', body: gif });
    return route.fulfill({ contentType: 'image/png', body: url.includes('peer') ? peerPng : mePng });
  });
  await page.route('**/ui-storage/**', async route => {
    const request = route.request();
    puts.push({ url: request.url(), contentType: await request.headerValue('content-type') ?? undefined, body: request.postDataBuffer() ?? Buffer.alloc(0) });
    if (putFails) return route.abort('failed');
    return route.fulfill({ status: 200, headers: { ETag: '"etag-1"' }, body: '' });
  });
  await page.route('**/api/v1/me', async route => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const input = request.postDataJSON() as { avatar_attachment_id?: string | null };
      patches.push(input);
      if (patchFailure) return route.fulfill({ status: patchFailure.status, json: { error: { code: patchFailure.code, message: 'Synthetic failure', request_id: null } } });
      myAvatar = input.avatar_attachment_id ? photo('me') : null;
      return route.fulfill({ json: { data: { user: user() } } });
    }
    return route.fulfill({ json: { data: { user: user(), settings: { locale: 'th', timezone: 'Asia/Bangkok', notification: null } } } });
  });
  await page.route('**/api/v1/uploads', async route => {
    const input = route.request().postDataJSON() as UploadCall;
    uploads.push(input);
    const id = `att-new-${uploads.length}`;
    return route.fulfill({ json: { data: { attachment_id: id, put_url: `${new URL(route.request().url()).origin}/ui-storage/${id}`, multipart: null, headers: { 'Content-Type': input.mime_type }, expires_at: '2099-01-01T00:00:00Z' } } });
  });
  await page.route('**/api/v1/uploads/*/complete', route => {
    const id = route.request().url().split('/').at(-2)!;
    completes.push(id);
    return route.fulfill({ json: { data: { attachment: { id, kind: 'avatar', status: opts.processing ? 'processing' : 'ready' } } } });
  });
  await page.route('**/api/v1/attachments/*', route => {
    polls++;
    return route.fulfill({ json: { data: { attachment: { id: route.request().url().split('/').at(-1), kind: 'avatar', status: 'ready' } } } });
  });
  // Messages: the fixture's peer, carrying whatever photo the "server" has now.
  await page.route(/\/api\/v1\/rooms\/[^/]+\/messages(\?.*)?$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const before = Number(url.searchParams.get('before_seq') ?? 0);
    const all = Array.from({ length: 40 }, (_, i) => message(i + 1)).map(m => m.sender?.id === me.id
      ? { ...m, sender: { ...m.sender, avatar: myAvatar } }
      : { ...m, sender: { ...m.sender!, avatar_attachment_id: peerAvatar ? 'att-peer' : null, avatar: peerAvatar } });
    const messages = before ? all.filter(m => m.seq < before) : all.slice(20);
    return route.fulfill({ json: { data: { messages, has_more_before: !before, has_more_after: false } } });
  });
  return {
    uploads, puts, patches, completes, emit: chat.emit,
    polls: () => polls,
    setPeerAvatar: (value: UserAvatar | null) => { peerAvatar = value; },
    setMyAvatar: (value: UserAvatar | null) => { myAvatar = value; },
    failPatch: (value: typeof patchFailure) => { patchFailure = value; },
    failPut: (value: boolean) => { putFails = value; },
    files: { gif },
  };
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Account menu' });
const editor = (page: Page) => page.getByTestId('avatar-editor');

async function openEditor(page: Page) {
  await trigger(page).click();
  await page.getByRole('menuitem', { name: 'เปลี่ยนรูปโปรไฟล์' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByRole('heading', { name: 'รูปโปรไฟล์' })).toBeVisible();
  await settle(page);
}

/** Let the open animation (scale/slide) finish before measuring geometry. */
async function settle(page: Page) {
  await editor(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
}

async function choose(page: Page, name: string, mimeType: string, buffer?: Buffer) {
  await page.getByTestId('avatar-file-input').setInputFiles({ name, mimeType, buffer: buffer ?? await file(name) });
}

/** A photo must be a true circle: square box, 50% radius, exactly inside its tile. */
async function expectCirclePhoto(photo: Locator) {
  await expect(photo).toBeVisible();
  const box = (await photo.boundingBox())!;
  const tile = (await photo.locator('xpath=..').boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
  expect(box.width).toBeGreaterThan(10);
  expect(Math.abs(box.x - tile.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.y - tile.y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.width - tile.width)).toBeLessThanOrEqual(0.5);
  const style = await photo.evaluate(el => {
    const own = getComputedStyle(el);
    const parent = getComputedStyle(el.parentElement!);
    return { fit: own.objectFit, radius: parent.borderTopLeftRadius, overflow: parent.overflow, loaded: el.classList.contains('is-loaded') };
  });
  expect(style.fit).toBe('cover');
  expect(style.radius).toBe('50%');
  expect(style.overflow).toBe('hidden');
  expect(style.loaded).toBe(true);
}

/** Dialog fully on screen, nothing scrolls sideways, every control ≥44px. */
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
  const stage = (await page.getByTestId('avatar-stage').boundingBox())!;
  expect(Math.abs(stage.width - stage.height)).toBeLessThanOrEqual(0.5);
  expect(stage.x).toBeGreaterThanOrEqual(box.x);
  expect(stage.x + stage.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  // the crop circle is centred in the stage and is a circle
  const circle = (await page.getByTestId('avatar-circle').boundingBox())!;
  expect(Math.abs(circle.width - circle.height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((circle.x + circle.width / 2) - (stage.x + stage.width / 2))).toBeLessThanOrEqual(0.75);
  expect(Math.abs((circle.y + circle.height / 2) - (stage.y + stage.height / 2))).toBeLessThanOrEqual(0.75);
  for (const control of await editor(page).locator('button:visible').all()) {
    const b = (await control.boundingBox())!;
    expect(b.height, await control.textContent() ?? '').toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.x).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

/** Width/height of a RIFF WEBP (VP8, VP8L or VP8X). */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === 'VP8L') { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
  return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
}

test.describe('FR-PROF-006 profile photo', () => {
  test('TC-WEB-AVATAR-001 account menu opens an accessible editor that starts empty and closes back to the trigger', async ({ page }) => {
    await avatarFixture(page);
    await page.goto('/');
    await expect(trigger(page).locator('.bc-avatar')).toHaveText('AM');
    await openEditor(page);
    await expect(editor(page)).toHaveAttribute('aria-labelledby', /.+/);
    await expect(page.getByTestId('avatar-choose')).toBeFocused();
    await expect(page.getByTestId('avatar-drop-zone')).toContainText('ลากรูปมาวางที่นี่');
    await expect(page.getByTestId('avatar-drop-zone')).toContainText('JPG, PNG, WebP หรือ GIF · ไม่เกิน 5 MB');
    await expect(editor(page)).toContainText('ยังไม่มีรูป');
    await expect(page.getByTestId('avatar-save')).toBeDisabled();
    await expect(page.getByTestId('avatar-remove')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test('TC-WEB-AVATAR-002 a still is cropped (drag, keys, zoom) to a square webp and saved via upload → PUT → complete → PATCH /me', async ({ page }) => {
    const api = await avatarFixture(page);
    await page.goto('/');
    await openEditor(page);
    await choose(page, 'avatar-landscape.png', 'image/png');
    const stage = page.getByTestId('avatar-stage');
    const image = page.getByTestId('avatar-crop-image');
    await expect(image).toBeVisible();
    await expect(stage).toBeFocused();
    await expect(page.getByTestId('avatar-save')).toBeEnabled();
    // zoom 1: the short edge exactly fills the circle
    const circle = (await page.getByTestId('avatar-circle').boundingBox())!;
    const start = (await image.boundingBox())!;
    expect(Math.abs(start.height - circle.height)).toBeLessThanOrEqual(1);
    // drag right is clamped at the image edge (never an empty corner)
    await page.mouse.move(circle.x + circle.width / 2, circle.y + circle.height / 2);
    await page.mouse.down();
    await page.mouse.move(circle.x + circle.width / 2 + 400, circle.y + circle.height / 2, { steps: 6 });
    await page.mouse.up();
    const dragged = (await image.boundingBox())!;
    expect(Math.abs(dragged.x - circle.x)).toBeLessThanOrEqual(1);
    await stage.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await image.boundingBox())!.x).toBeLessThan(dragged.x - 7);
    await page.keyboard.press('0');
    await page.getByTestId('avatar-zoom').fill('2');
    await expect.poll(async () => Math.round((await image.boundingBox())!.height)).toBe(Math.round(circle.height * 2));
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();

    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0]).toMatchObject({ kind: 'avatar', mime_type: 'image/webp', filename: 'avatar.webp' });
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]!.contentType).toBe('image/webp');
    expect(api.puts[0]!.body.length).toBe(api.uploads[0]!.size_bytes);
    // 1600x1000 at zoom 2 → the circle covers 500 source px → 500x500, not upscaled, ≤1024
    expect(webpSize(api.puts[0]!.body)).toEqual({ width: 500, height: 500 });
    expect(api.completes).toEqual(['att-new-1']);
    expect(api.patches).toEqual([{ avatar_attachment_id: 'att-new-1' }]);
    await expectCirclePhoto(trigger(page).getByTestId('avatar-photo'));
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
  });

  test('TC-WEB-AVATAR-003 a GIF skips the canvas: animated preview, centre-crop hint, original bytes uploaded unchanged', async ({ page }) => {
    const api = await avatarFixture(page);
    await page.goto('/');
    await openEditor(page);
    await choose(page, 'avatar-anim.gif', 'image/gif');
    const preview = page.getByTestId('avatar-gif-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^blob:/);
    await expect(page.getByTestId('avatar-crop-image')).toHaveCount(0);
    await expect(page.getByTestId('avatar-zoom')).toHaveCount(0);
    await expect(page.getByTestId('avatar-gif-hint')).toHaveText('GIF จะถูกครอปตรงกลางอัตโนมัติ เพื่อให้ภาพเคลื่อนไหวคงอยู่');
    await expect(editor(page)).toContainText('GIF เคลื่อนไหว');
    const previewBox = (await preview.boundingBox())!;
    const circle = (await page.getByTestId('avatar-circle').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(previewBox[key] - circle[key])).toBeLessThanOrEqual(0.5);
    expect(await preview.evaluate(el => getComputedStyle(el).objectFit)).toBe('cover');
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(api.uploads[0]).toMatchObject({ kind: 'avatar', mime_type: 'image/gif', filename: 'avatar-anim.gif', size_bytes: api.files.gif.length });
    expect(api.puts[0]!.body.equals(api.files.gif)).toBe(true);
    expect(api.patches).toEqual([{ avatar_attachment_id: 'att-new-1' }]);
  });

  test('TC-WEB-AVATAR-004 an animated avatar plays, but reduced motion shows the static first-frame thumb', async ({ page }) => {
    await avatarFixture(page, { avatar: photo('me', true) });
    await page.goto('/');
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me.gif');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
    await openEditor(page);
    // the editor's large current photo uses md, still honouring reduced motion
    await expect(page.getByTestId('avatar-circle').getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-md.png');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByTestId('avatar-circle').getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me.gif');
  });

  test('TC-WEB-AVATAR-005 wrong type, too large, AVATAR_INVALID and network failures are human errors that keep the dialog usable', async ({ page }) => {
    const api = await avatarFixture(page);
    await page.goto('/');
    await openEditor(page);
    const error = page.getByTestId('avatar-error');
    await choose(page, 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    await expect(error).toHaveText('ใช้ได้เฉพาะไฟล์ JPG, PNG, WebP หรือ GIF');
    await expect(error).toHaveAttribute('role', 'alert');
    await choose(page, 'huge.png', 'image/png', Buffer.alloc(5 * 1024 * 1024 + 1));
    await expect(error).toHaveText('รูปนี้ใหญ่เกิน 5 MB ลองย่อรูปหรือเลือกรูปอื่น');
    await expect(page.getByTestId('avatar-save')).toBeDisabled();
    await choose(page, 'broken.png', 'image/png', Buffer.from('not really a png'));
    await expect(error).toHaveText('เปิดรูปนี้ไม่ได้ ไฟล์อาจเสียหาย ลองเลือกรูปอื่น');
    expect(api.uploads).toHaveLength(0);

    await choose(page, 'avatar-anim.gif', 'image/gif');
    await expect(error).toHaveCount(0);
    api.failPut(true);
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
    await expect(page.getByTestId('avatar-save')).toBeEnabled();
    api.failPut(false);
    api.failPatch({ status: 422, code: 'AVATAR_INVALID' });
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('ตั้งรูปนี้ไม่ได้ กรุณาอัปโหลดใหม่อีกครั้ง');
    api.failPatch({ status: 422, code: 'MEDIA_TOO_LARGE' });
    await page.getByTestId('avatar-save').click();
    await expect(error).toHaveText('เซิร์ฟเวอร์ปฏิเสธเพราะไฟล์ใหญ่เกินกำหนด ลองรูปที่เล็กลง');
    api.failPatch(null);
    await page.getByTestId('avatar-save').click();
    await expect(editor(page)).toHaveCount(0);
    expect(api.patches.at(-1)).toEqual({ avatar_attachment_id: 'att-new-4' });
  });

  test('TC-WEB-AVATAR-006 remove photo asks first, then PATCHes null and falls back to initials', async ({ page }) => {
    const api = await avatarFixture(page, { avatar: photo('me') });
    await page.goto('/');
    await expectCirclePhoto(trigger(page).getByTestId('avatar-photo'));
    await openEditor(page);
    await page.getByTestId('avatar-remove').click();
    const confirm = page.getByTestId('avatar-remove-confirm');
    await expect(confirm).toContainText('ลบรูปโปรไฟล์?');
    await expect(confirm.getByRole('button', { name: 'เก็บไว้' })).toBeFocused();
    await confirm.getByRole('button', { name: 'เก็บไว้' }).click();
    expect(api.patches).toHaveLength(0);
    await page.getByTestId('avatar-remove').click();
    await page.getByTestId('avatar-remove-confirm-button').click();
    await expect(editor(page)).toHaveCount(0);
    expect(api.patches).toEqual([{ avatar_attachment_id: null }]);
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveCount(0);
    await expect(trigger(page).locator('.bc-avatar')).toHaveText('AM');
  });

  test('TC-WEB-AVATAR-007 a broken image falls back to initials with no layout shift', async ({ page }) => {
    await avatarFixture(page, { avatar: { sm: '/ui-avatars/broken-sm.png', md: '/ui-avatars/broken-md.png', animated: null } });
    await page.goto('/');
    const tile = trigger(page).locator('.bc-avatar');
    await expect(tile).toHaveText('AM');
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveCount(0);
    const box = (await tile.boundingBox())!;
    expect(box.width).toBe(37);
    expect(box.height).toBe(37);
  });

  test('TC-WEB-AVATAR-008 peers show their photo on messages; a workspace user.updated refreshes every loaded row', async ({ page }) => {
    const api = await avatarFixture(page, { peerAvatar: photo('peer') });
    await page.goto('/rooms/ui-design');
    await expect(page.locator('[data-seq="40"]')).toBeVisible();
    const peerPhotos = page.locator('.bc-message[data-mine=false][data-grouped=false] .bc-message-avatar [data-testid=avatar-photo]');
    await expect(peerPhotos.first()).toHaveAttribute('src', '/ui-avatars/peer-sm.png');
    await expectCirclePhoto(peerPhotos.last());
    // own bubbles carry no avatar in this layout (right-aligned, FR-MSG-003)
    await expect(page.locator('.bc-message[data-mine=true] .bc-avatar')).toHaveCount(0);
    // older page loaded before the change must be re-stamped too
    await page.getByTestId('message-list').evaluate(el => { el.scrollTop = 0; });
    await expect(page.locator('[data-seq="2"]')).toBeAttached();
    api.setPeerAvatar(photo('peer-new'));
    await api.emit('user.updated', { user_id: 'ui-peer' }, 'private-workspace.ui-workspace');
    await expect(page.locator('[data-seq="39"] [data-testid=avatar-photo]')).toHaveAttribute('src', '/ui-avatars/peer-new-sm.png');
    await expect(page.locator('[data-seq="2"] [data-testid=avatar-photo]')).toHaveAttribute('src', '/ui-avatars/peer-new-sm.png');
    // my own change made in another tab arrives on private-user (EVT-086)
    api.setMyAvatar(photo('me'));
    await api.emit('user.updated', { user_id: me.id }, `private-user.${me.id}`);
    await expect(trigger(page).getByTestId('avatar-photo')).toHaveAttribute('src', '/ui-avatars/me-sm.png');
  });

  test('TC-WEB-AVATAR-009 paste and drop open the cropper; processing is awaited before PATCH', async ({ page }) => {
    const api = await avatarFixture(page, { processing: true });
    await page.goto('/');
    await openEditor(page);
    const png = await file('avatar-landscape.png');
    await page.evaluate(async bytes => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'clip.png', { type: 'image/png' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
    }, [...png]);
    await expect(page.getByTestId('avatar-crop-image')).toBeVisible();
    await page.getByTestId('avatar-choose-other').isVisible();
    await page.evaluate(async bytes => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.gif', { type: 'image/gif' }));
      const target = document.querySelector('[data-testid="avatar-editor"]')!;
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, [...api.files.gif]);
    await expect(page.getByTestId('avatar-gif-preview')).toBeVisible();
    await page.getByTestId('avatar-save').click();
    await expect(page.getByTestId('avatar-status')).toHaveText(/กำลังประมวลผลรูป|กำลังตั้งเป็นรูปโปรไฟล์/);
    await expect(editor(page)).toHaveCount(0, { timeout: 10_000 });
    expect(api.polls()).toBeGreaterThanOrEqual(1);
    expect(api.patches).toEqual([{ avatar_attachment_id: 'att-new-1' }]);
  });

  for (const [width, height] of [[360, 740], [1280, 800]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`TC-WEB-AVATAR-010 editor geometry + screenshots ${width}x${height} ${scheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: scheme });
        await avatarFixture(page, { avatar: photo('me') });
        await page.goto('/');
        await expectCirclePhoto(trigger(page).getByTestId('avatar-photo'));
        await openEditor(page);
        await mkdir(shots, { recursive: true });
        await expectCirclePhoto(page.getByTestId('avatar-circle').getByTestId('avatar-photo'));
        await expectDialogFits(page);
        await page.screenshot({ path: `${shots}/editor-empty-${width}-${scheme}.png` });

        await choose(page, 'avatar-landscape.png', 'image/png');
        await expect(page.getByTestId('avatar-crop-image')).toBeVisible();
        await page.getByTestId('avatar-zoom').fill('1.4');
        await expectDialogFits(page);
        const zoom = (await page.getByTestId('avatar-zoom').boundingBox())!;
        expect(zoom.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: `${shots}/editor-crop-${width}-${scheme}.png` });

        await choose(page, 'avatar-anim.gif', 'image/gif');
        await expect(page.getByTestId('avatar-gif-preview')).toBeVisible();
        await expectDialogFits(page);
        await page.screenshot({ path: `${shots}/editor-gif-${width}-${scheme}.png` });
      });
    }
  }
});
