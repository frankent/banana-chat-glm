import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { RoomCall, UserAvatar } from '@banana-chat/shared';
import { installChatFixture } from './fixtures';

/**
 * FR-PROF-007 / DEC-089 — profile photos in calls and public meetings.
 *
 * A real LiveKit SFU is not available here, so tiles are exercised through
 * e2e/ui/harness/call-tiles.html: the production MediaPanel `Tiles` on a
 * never-connected `Room` holding synthetic participants whose metadata is the
 * exact JSON the join token mints. The incoming banner and the DM call header
 * run in the real app with every API response mocked (the media connect is
 * pointed at a dead port and fails, which leaves the call dialog mounted).
 */
const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/call-avatar-shots';
const assets = resolve(import.meta.dirname, 'assets');
const viewports = [{ width: 360, height: 740 }, { width: 1280, height: 800 }] as const;

async function serveAvatars(page: Page) {
  const [peerPng, mePng, gif] = await Promise.all(['peer-avatar.png', 'me-avatar.png', 'avatar-anim.gif'].map(name => readFile(resolve(assets, name))));
  await page.route('**/ui-avatars/**', route => {
    const url = route.request().url();
    if (url.includes('broken')) return route.fulfill({ status: 404, body: '' });
    if (url.endsWith('.gif')) return route.fulfill({ contentType: 'image/gif', body: gif });
    return route.fulfill({ contentType: 'image/png', body: url.includes('peer') ? peerPng : mePng });
  });
}

async function openHarness(page: Page, query = '') {
  await serveAvatars(page);
  await page.goto(`/e2e/ui/harness/call-tiles.html${query}`);
  await expect(page.locator('.lk-participant-tile').first()).toBeVisible();
}

/** Wait until the photo layer has faded in and every photo has decoded or fallen back, so screenshots are final. */
async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const layers = [...document.querySelectorAll<HTMLElement>('.lk-participant-tile[data-lk-video-muted="true"] .bc-call-placeholder')];
    const photos = [...document.querySelectorAll<HTMLImageElement>('.bc-avatar-photo')];
    return layers.every(el => getComputedStyle(el).opacity === '1')
      && photos.every(img => img.classList.contains('is-loaded') && getComputedStyle(img).opacity === '1');
  })).toBe(true);
}

const tileOf = (page: Page, name: string, scope = '.bc-call-grid') => page.locator(`${scope} .lk-participant-tile`).filter({ has: page.locator('.bc-call-person-name', { hasText: name }) });

/** Every visible camera-off photo is a true circle, centred horizontally in its tile and fully inside it. */
async function assertPhotoGeometry(tiles: Locator) {
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const tile = tiles.nth(i);
    const photo = tile.locator('.bc-call-photo');
    const [tb, pb] = [await tile.boundingBox(), await photo.boundingBox()];
    expect(tb && pb).toBeTruthy();
    const t = tb!, p = pb!;
    expect(Math.abs(p.width - p.height), 'photo is square').toBeLessThanOrEqual(1);
    expect(p.width, 'photo is not collapsed').toBeGreaterThanOrEqual(24);
    expect(p.x, 'left inside tile').toBeGreaterThanOrEqual(t.x - 0.5);
    expect(p.y, 'top inside tile').toBeGreaterThanOrEqual(t.y - 0.5);
    expect(p.x + p.width, 'right inside tile').toBeLessThanOrEqual(t.x + t.width + 0.5);
    expect(p.y + p.height, 'bottom inside tile').toBeLessThanOrEqual(t.y + t.height + 0.5);
    expect(Math.abs((p.x + p.width / 2) - (t.x + t.width / 2)), 'centred horizontally').toBeLessThanOrEqual(1);
    // Vertically the photo+name group is centred (nudged ≤ a few % up for the mic bar).
    expect(Math.abs((p.y + p.height / 2) - (t.y + t.height / 2)), 'near vertical centre').toBeLessThanOrEqual(t.height * 0.3);
    const radius = await photo.locator('.bc-avatar').evaluate(el => {
      const style = getComputedStyle(el);
      return { r: parseFloat(style.borderTopLeftRadius), w: el.getBoundingClientRect().width, pct: style.borderTopLeftRadius };
    });
    expect(radius.pct.endsWith('%') ? parseFloat(radius.pct) >= 50 : radius.r >= radius.w / 2 - 0.5, 'circle').toBe(true);
    const name = tile.locator('.bc-call-person-name');
    if (await name.isVisible()) {
      const nb = (await name.boundingBox())!;
      expect(nb.y, 'name under the photo').toBeGreaterThanOrEqual(p.y + p.height - 0.5);
      expect(nb.x).toBeGreaterThanOrEqual(t.x - 0.5);
      expect(nb.x + nb.width).toBeLessThanOrEqual(t.x + t.width + 0.5);
      expect(nb.y + nb.height).toBeLessThanOrEqual(t.y + t.height + 0.5);
    }
  }
}

async function expectPhoto(tile: Locator, src: RegExp) {
  const img = tile.locator('.bc-call-photo .bc-avatar.has-photo .bc-avatar-photo.is-loaded');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', src);
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
}
async function expectInitials(tile: Locator, initials: string) {
  await expect(tile.locator('.bc-call-photo .bc-avatar-photo')).toHaveCount(0);
  await expect(tile.locator('.bc-call-photo .bc-avatar')).toHaveText(initials);
}

test.describe('FR-PROF-007 call and meeting avatars', () => {
  test.beforeAll(() => mkdir(shots, { recursive: true }));

  for (const viewport of viewports) {
    test(`TC-WEB-CALLAVATAR-001 camera-off grid shows GIF, still, guest and broken-photo tiles as centred circles @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHarness(page);
      // A phone paginates LiveKit's grid (2 per page at 360px): walk every page.
      const pages = viewport.width < 600 ? 2 : 1;
      await expect(page.locator('.bc-call-grid [data-testid=call-person]')).toHaveCount(4 / pages);
      for (let index = 0; index < pages; index++) {
        if (index > 0) await page.locator('.lk-pagination-control button').last().click();
        const expected = index === 0 || pages === 1
          ? [['Alex Morgan', 'photo', /\/ui-avatars\/me-md\.png$/], ['มินตรา Chen', 'photo', /\/ui-avatars\/peer\.gif$/]] as const
          : [];
        const initials = index === pages - 1 ? [['Sam Guest', 'SG'], ['Broken Photo', 'BP']] as const : [];
        for (const [name, , src] of expected) await expectPhoto(tileOf(page, name), src);
        for (const [name, text] of initials) await expectInitials(tileOf(page, name), text);
        await settle(page);
        // LiveKit's own placeholder visibility rule shows the photo layer.
        await expect(page.locator('.bc-call-grid .bc-call-placeholder').first()).toHaveCSS('opacity', '1');
        // The name is under the photo, not duplicated in the bottom metadata bar.
        await expect(page.locator('.bc-call-grid .lk-participant-metadata .lk-participant-name').first()).toBeHidden();
        await assertPhotoGeometry(page.locator('.bc-call-grid .lk-participant-tile'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${shots}/grid-${viewport.width}${pages > 1 ? `-page${index + 1}` : ''}.png` });
      }
    });

    test(`TC-WEB-CALLAVATAR-002 focus stage and thumbnail strip keep centred circles @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHarness(page);
      // FR-CALL-007 picker unchanged: choosing a participant stages it.
      await page.getByLabel('Focus participant or screen').selectOption({ label: 'มินตรา Chen — participant' });
      const stage = page.locator('.bc-call-focus .lk-participant-tile');
      await expect(stage).toHaveCount(1);
      await expect(stage.locator('.bc-call-person-name')).toHaveText('มินตรา Chen');
      await expectPhoto(stage, /peer\.gif$/);
      await assertPhotoGeometry(page.locator('.bc-call-focus .lk-participant-tile'));
      const thumbs = page.locator('.bc-call-thumbnails .lk-participant-tile');
      await expect(thumbs).toHaveCount(4);
      await assertPhotoGeometry(thumbs);
      // 85px thumbnails drop the in-tile name (the Show … button carries it).
      await expect(thumbs.first().locator('.bc-call-person-name')).toBeHidden();
      await settle(page);
      await page.screenshot({ path: `${shots}/focus-${viewport.width}.png` });
      await page.getByRole('button', { name: 'Automatic view' }).click();
      await expect(page.locator('.bc-call-focus')).toHaveCount(0);
      await page.getByLabel('Focus participant or screen').selectOption({ label: 'Sam Guest — participant' });
      await expectInitials(page.locator('.bc-call-focus .lk-participant-tile'), 'SG');
    });
  }

  test('TC-WEB-CALLAVATAR-003 reduced motion shows the still md thumb instead of the GIF', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHarness(page);
    await expectPhoto(tileOf(page, 'มินตรา Chen'), /\/ui-avatars\/peer-md\.png$/);
  });

  test('TC-WEB-CALLAVATAR-004 speaking shows a ring around the photo, not the tile edge', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHarness(page);
    const tile = tileOf(page, 'มินตรา Chen');
    const ring = () => tile.locator('.bc-call-photo').evaluate(el => getComputedStyle(el).boxShadow);
    expect(await ring()).not.toContain('rgb(66, 216, 165)');
    await page.evaluate(() => (window as unknown as { __callHarness: { speak(id: string, on: boolean): void } }).__callHarness.speak('ui-peer', true));
    await expect(tile).toHaveAttribute('data-lk-speaking', 'true');
    await expect.poll(ring).toContain('rgb(66, 216, 165)');
    await settle(page);
    // LiveKit's tile-edge indicator is suppressed on camera-off tiles.
    expect(await tile.evaluate(el => getComputedStyle(el, '::after').borderTopWidth)).toBe('0px');
    await page.screenshot({ path: `${shots}/speaking-1280.png` });
    await page.evaluate(() => (window as unknown as { __callHarness: { speak(id: string, on: boolean): void } }).__callHarness.speak('ui-peer', false));
    await expect.poll(ring).not.toContain('rgb(66, 216, 165)');
  });

  test('TC-WEB-CALLAVATAR-005 a metadata change (rejoin with a new token) re-renders the photo', async ({ page }) => {
    await openHarness(page);
    await expectInitials(tileOf(page, 'Sam Guest'), 'SG');
    await page.evaluate(() => {
      const h = (window as unknown as { __callHarness: { setAvatar(id: string, a: unknown): void; photo(n: string): unknown } }).__callHarness;
      h.setAvatar('guest-1', h.photo('peer'));
    });
    await expectPhoto(tileOf(page, 'Sam Guest'), /peer-md\.png$/);
    // Garbage metadata falls back to initials rather than breaking the tile.
    await page.evaluate(() => (window as unknown as { __callHarness: { setAvatar(id: string, a: unknown): void } }).__callHarness.setAvatar('guest-1', { sm: 'javascript:alert(1)', md: 'javascript:alert(1)' }));
    await expectInitials(tileOf(page, 'Sam Guest'), 'SG');
  });

  test('TC-WEB-CALLAVATAR-006 a live camera keeps LiveKit video and shows no photo', async ({ page }) => {
    await openHarness(page, '?camera=1');
    const local = page.locator('.bc-call-grid .lk-participant-tile[data-lk-local-participant="true"]');
    await expect(local).toHaveAttribute('data-lk-video-muted', 'false');
    await expect(local.locator('video')).toHaveCount(1);
    await expect(local.locator('[data-testid=call-person]')).toHaveCount(0);
    await expect(local.locator('.lk-participant-metadata .lk-participant-name')).toHaveText('Alex Morgan');
    await expect(page.locator('.bc-call-grid [data-testid=call-person]')).toHaveCount(3);
  });

  test('TC-WEB-CALLAVATAR-007 voice calls use the same photo tiles', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openHarness(page, '?voice=1&people=1');
    await expect(page.locator('[data-testid=call-person]')).toHaveCount(2);
    await assertPhotoGeometry(page.locator('.bc-call-grid .lk-participant-tile'));
    await settle(page);
    await page.screenshot({ path: `${shots}/voice-360.png` });
  });

  // ---- real app: incoming banner + DM call header (API mocked) ----

  const baseCall = (over: Partial<RoomCall> = {}): RoomCall => ({
    id: 'ui-call-1', room_id: 'ui-direct', workspace_id: 'ui-workspace', kind: 'voice', started_by: 'ui-peer', caller_name: 'มินตรา Chen',
    room_name: 'มินตรา Chen', room_type: 'dm', participants: ['ui-peer'], created_at: new Date().toISOString(), connected_at: null, ended_at: null, ...over,
  });

  async function appWithCall(page: Page, call: RoomCall) {
    await installChatFixture(page);
    await serveAvatars(page);
    let current = call;
    await page.route('**/api/v1/calls', route => route.fulfill({ json: { data: { enabled: true, calls: [{ ...current, created_at: new Date().toISOString() }] } } }));
    await page.route('**/api/v1/calls/*/join', route => {
      current = { ...current, participants: [...current.participants, 'ui-me'] };
      return route.fulfill({ json: { data: { call: current, token: 'synthetic.media.token', url: 'ws://127.0.0.1:9' } } });
    });
    await page.route('**/api/v1/calls/*/leave', route => route.fulfill({ status: 204 }));
    await page.goto('/');
    return page.getByRole('dialog', { name: 'Incoming call' });
  }

  for (const viewport of viewports) {
    test(`TC-WEB-CALLAVATAR-008 incoming call banner shows the caller photo @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const peer = `http://127.0.0.1:5180/ui-avatars/peer`;
      const avatar: UserAvatar = { sm: `${peer}-sm.png`, md: `${peer}-md.png`, animated: `${peer}.gif` };
      const banner = await appWithCall(page, baseCall({ caller_avatar: avatar, peer_avatar: avatar }));
      await expect(banner).toBeVisible();
      const caller = banner.getByTestId('incoming-caller');
      const img = caller.locator('.bc-avatar-photo.is-loaded');
      await expect(img).toHaveAttribute('src', /peer\.gif$/);
      const [bb, cb] = [(await banner.boundingBox())!, (await caller.boundingBox())!];
      expect(Math.abs(cb.width - cb.height)).toBeLessThanOrEqual(1);
      expect(cb.width).toBeGreaterThanOrEqual(40);
      expect(cb.x).toBeGreaterThanOrEqual(bb.x);
      expect(cb.y).toBeGreaterThanOrEqual(bb.y);
      expect(cb.y + cb.height).toBeLessThanOrEqual(bb.y + bb.height);
      expect(bb.x + bb.width).toBeLessThanOrEqual(viewport.width);
      await expect(banner.getByRole('button', { name: 'Join' })).toBeVisible();
      for (const button of await banner.getByRole('button').all()) {
        const b = (await button.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(bb.x);
        expect(b.x + b.width).toBeLessThanOrEqual(bb.x + bb.width + 0.5);
      }
      // The caller name gets real room, not a squeezed sliver beside the buttons.
      expect((await banner.locator('strong').boundingBox())!.width).toBeGreaterThanOrEqual(80);
      await expect(img).toHaveCSS('opacity', '1');
      await page.screenshot({ path: `${shots}/incoming-${viewport.width}.png` });
    });
  }

  test('TC-WEB-CALLAVATAR-009 no caller photo falls back to initials; DM call header shows the peer photo', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const peer = `http://127.0.0.1:5180/ui-avatars/peer`;
    const banner = await appWithCall(page, baseCall({ caller_avatar: null, peer_avatar: { sm: `${peer}-sm.png`, md: `${peer}-md.png`, animated: null } }));
    await expect(banner.getByTestId('incoming-caller').locator('.bc-avatar')).toHaveText('มC');
    await expect(banner.getByTestId('incoming-caller').locator('.bc-avatar-photo')).toHaveCount(0);
    await banner.getByRole('button', { name: 'Join' }).click();
    const dialog = page.getByRole('dialog', { name: 'Voice call' });
    await expect(dialog).toBeVisible();
    const header = dialog.locator('header .bc-call-header-avatar');
    await expect(header.locator('.bc-avatar-photo.is-loaded')).toHaveAttribute('src', /peer-sm\.png$/);
    const hb = (await header.boundingBox())!;
    expect(Math.abs(hb.width - hb.height)).toBeLessThanOrEqual(1);
    await expect(header.locator('.bc-avatar-photo')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: `${shots}/dm-header-1280.png` });
  });

  test('TC-WEB-CALLAVATAR-010 group call header keeps the plain title', async ({ page }) => {
    const banner = await appWithCall(page, baseCall({ room_id: 'ui-design', room_type: 'group', room_name: 'Design studio · ออกแบบ', kind: 'video', caller_avatar: null, peer_avatar: null }));
    await banner.getByRole('button', { name: 'Join' }).click();
    const dialog = page.getByRole('dialog', { name: 'Video call' });
    await expect(dialog.locator('header strong')).toHaveText('Design studio · ออกแบบ');
    await expect(dialog.locator('header .bc-call-header-avatar')).toHaveCount(0);
  });
});
