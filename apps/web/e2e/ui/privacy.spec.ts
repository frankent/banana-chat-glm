import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { installChatFixture, me, openChat } from './fixtures';

const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/privacy-shots';
const lock = (page: Page) => page.getByTestId('privacy-lock-screen');
const password = (page: Page) => page.getByTestId('privacy-password');

// All API/WebSocket traffic is synthetic; no real accounts, passwords, or workspace writes.
async function fixture(page: Page, enabled = true, holdMe = false) {
  const chat = await installChatFixture(page);
  await page.addInitScript(value => {
    if (value) localStorage.setItem('bc.privacy_mode', '1');
    else localStorage.removeItem('bc.privacy_mode');
  }, enabled);
  let privacy = enabled;
  let releaseMe!: () => void;
  const meGate = holdMe ? new Promise<void>(resolve => { releaseMe = resolve; }) : Promise.resolve();
  let failure: 'wrong' | 'limited' | 'offline' | null = null;
  let releaseVerify: (() => void) | undefined;
  let verifyGate: Promise<void> | null = null;
  let rejectSave = false;
  let saveGate: Promise<void> | null = null;
  let releaseSave: (() => void) | undefined;
  const saves: boolean[] = [];
  const verifications: string[] = [];
  await page.route('**/api/v1/me', async route => {
    await meGate;
    await route.fulfill({ json: { data: { user: { ...me, locale: 'th' }, settings: { locale: 'th', timezone: 'Asia/Bangkok', notification: { privacy_mode: privacy } } } } });
  });
  await page.route('**/api/v1/me/notification-settings', async route => {
    const value = route.request().postDataJSON().privacy_mode as boolean;
    saves.push(value);
    if (saveGate) await saveGate;
    if (rejectSave) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Synthetic failure' } } });
    privacy = value;
    return route.fulfill({ json: { data: { settings: { privacy_mode: privacy } } } });
  });
  await page.route('**/api/v1/me/verify-password', async route => {
    verifications.push(route.request().postDataJSON().password);
    if (verifyGate) await verifyGate;
    if (failure === 'offline') return route.abort('failed');
    if (failure) return route.fulfill({ status: failure === 'limited' ? 429 : 422, json: { error: { code: failure === 'limited' ? 'RATE_LIMITED' : 'INVALID_PASSWORD', message: 'Synthetic failure' } } });
    return route.fulfill({ status: 204 });
  });
  return {
    emit: chat.emit,
    serverPrivacy: (value: boolean) => { privacy = value; },
    saves, verifications,
    releaseMe: () => releaseMe?.(),
    fail: (value: typeof failure) => { failure = value; },
    failSave: (value: boolean) => { rejectSave = value; },
    holdSave: () => { saveGate = new Promise<void>(resolve => { releaseSave = resolve; }); },
    releaseSave: () => { releaseSave?.(); saveGate = null; },
    holdVerify: () => { verifyGate = new Promise<void>(resolve => { releaseVerify = resolve; }); },
    releaseVerify: () => { releaseVerify?.(); verifyGate = null; },
  };
}

async function visibility(page: Page, value: 'hidden' | 'visible') {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }, value);
}
async function unlock(page: Page) {
  await password(page).fill('synthetic-correct-password');
  await password(page).press('Enter');
  await expect(lock(page)).toHaveCount(0);
}
async function concealed(page: Page) {
  await expect(lock(page)).toBeVisible();
  await expect(page.locator('.bc-private-app')).toHaveAttribute('inert', '');
  await expect(page.locator('.bc-private-app')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByTestId('composer-input')).not.toBeVisible();
  await expect(page).toHaveTitle('Banana Chat');
}

test('TC-WEB-PRIVACY-010 cold mirror covers before /me and reload paints no readable chat', async ({ page }) => {
  const api = await fixture(page, true, true);
  await page.goto('/rooms/ui-design');
  await concealed(page);
  api.releaseMe();
  await expect(page.locator('[data-seq="40"]')).toBeAttached();
  await concealed(page);
  await unlock(page);
  await expect(page.locator('[data-seq="40"]')).toBeVisible();
  await page.reload();
  await concealed(page);
});

test('TC-WEB-PRIVACY-011 wrong password stays concealed, correct password keeps draft, every return relocks', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/rooms/ui-design');
  await unlock(page);
  const composer = page.getByTestId('composer-input');
  await composer.fill('Private unsent draft survives the overlay');
  await visibility(page, 'hidden');
  await concealed(page);
  await visibility(page, 'visible');
  api.fail('wrong');
  await password(page).fill('synthetic-wrong-password');
  await password(page).press('Enter');
  await expect(page.getByRole('alert')).toHaveText('รหัสผ่านไม่ถูกต้อง');
  await expect(password(page)).toHaveValue('');
  await concealed(page);
  api.fail(null);
  await unlock(page);
  await expect(composer).toHaveValue('Private unsent draft survives the overlay');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await concealed(page);
  await unlock(page);
  await expect(composer).toHaveValue('Private unsent draft survives the overlay');
});

test('TC-WEB-PRIVACY-012 stale successful verification after hide cannot unlock', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/rooms/ui-design');
  api.holdVerify();
  await password(page).fill('synthetic-password');
  await password(page).press('Enter');
  await expect.poll(() => api.verifications.length).toBe(1);
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  api.releaseVerify();
  await concealed(page);
  await unlock(page);
});

test('TC-WEB-PRIVACY-013 rate limit and network errors retain keyboard-accessible lock', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/rooms/ui-design');
  await expect(page.getByLabel('รหัสผ่าน', { exact: true })).toBeFocused();
  await expect(password(page)).toHaveAttribute('autocomplete', 'current-password');
  await password(page).fill('synthetic-password');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'แสดงรหัสผ่าน', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(password(page)).toHaveAttribute('type', 'text');
  for (const [failure, text] of [['limited', 'ลองบ่อยเกินไป รอสักครู่'], ['offline', 'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง']] as const) {
    api.fail(failure);
    await password(page).fill('synthetic-password');
    await password(page).press('Enter');
    await expect(page.getByRole('alert')).toHaveText(text);
    await expect(password(page)).toBeFocused();
    await concealed(page);
  }
  await page.keyboard.press('Escape');
  await concealed(page);
});

test('TC-WEB-PRIVACY-014 sign out removes privacy mirror and session', async ({ page }) => {
  await fixture(page);
  await page.goto('/rooms/ui-design');
  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await expect(lock(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('orgchat.refresh'))).toBeNull();
  await expect(page).toHaveURL(/\/login/);
});

test('TC-WEB-PRIVACY-015 toggle saves PUT, mirrors flag and rolls back failed disable', async ({ page }) => {
  const api = await fixture(page, false);
  await openChat(page);
  await page.getByTestId('notification-bell').click();
  const toggle = page.getByRole('switch', { name: 'โหมดส่วนตัว' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  api.holdSave();
  const request = page.waitForRequest(r => r.url().endsWith('/me/notification-settings') && r.method() === 'PUT');
  await toggle.click();
  expect((await request).postDataJSON()).toEqual({ privacy_mode: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeDisabled();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBe('1');
  api.releaseSave();
  await expect(toggle).toBeEnabled();
  api.failSave(true);
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('บันทึกโหมดส่วนตัวไม่สำเร็จ');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBe('1');
  expect(api.saves).toEqual([true, false]);
});

test('TC-WEB-PRIVACY-017 body portals and late native dialogs cannot obscure or expose the lock', async ({ page }) => {
  await fixture(page);
  await page.goto('/rooms/ui-design');
  await concealed(page);
  await page.evaluate(() => {
    const portal = document.createElement('div');
    portal.id = 'privacy-test-portal';
    portal.textContent = 'Sensitive portal notification';
    document.body.append(portal);
    const modal = document.createElement('dialog');
    modal.id = 'privacy-test-dialog';
    modal.textContent = 'Sensitive call dialog';
    document.body.append(modal);
    modal.showModal();
  });
  await expect(page.locator('#privacy-test-portal')).toHaveJSProperty('inert', true);
  await expect(page.locator('#privacy-test-dialog')).toHaveJSProperty('inert', true);
  await expect(page.locator('#privacy-test-portal')).not.toBeVisible();
  await expect(page.locator('#privacy-test-dialog')).not.toBeVisible();
  await password(page).fill('synthetic-password');
  await page.getByRole('button', { name: 'แสดงรหัสผ่าน', exact: true }).click();
  await expect(password(page)).toHaveAttribute('type', 'text');
  await concealed(page);
  await page.evaluate(() => {
    document.getElementById('privacy-test-dialog')?.remove();
    document.getElementById('privacy-test-portal')?.remove();
  });
});

test('TC-NOTI-041 native popup hides known room and sender and uses exact generic kind text', async ({ page }) => {
  const api = await fixture(page);
  await page.addInitScript(() => {
    const notifications: { title: string; options: NotificationOptions }[] = [];
    Object.assign(window, { privacyTestNotifications: notifications });
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) { notifications.push({ title, options }); }
      close() { /* Synthetic OS notification. */ }
    } });
  });
  await page.goto('/rooms/ui-design');
  await unlock(page);
  await expect(page.locator('[data-seq="40"]')).toBeVisible();
  await api.emit('notification.alert', { id: 'privacy-photo-alert', room_id: 'ui-product', kind: 'photo', sound: false }, 'private-user.ui-me');
  await expect.poll(() => page.evaluate(() => (window as Window & { privacyTestNotifications?: unknown[] }).privacyTestNotifications)).toEqual([
    { title: 'Banana Chat', options: { body: 'รูปภาพใหม่', tag: '/rooms/ui-product', renotify: false, silent: true } },
  ]);
  await expect(page).toHaveTitle('Banana Chat');
});

test('TC-WEB-PRIVACY-018 authoritative remote disable on visibility refresh clears lock and mirror', async ({ page }) => {
  const api = await fixture(page);
  await page.goto('/rooms/ui-design');
  await unlock(page);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await visibility(page, 'hidden');
  await concealed(page);
  api.serverPrivacy(false);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me');
  await visibility(page, 'visible');
  await refreshed;
  await expect(lock(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBeNull();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('TC-WEB-PRIVACY-019 trusted attachment picker cancellation consumes exemption without hide', async ({ page }) => {
  await fixture(page);
  await page.goto('/rooms/ui-design');
  await unlock(page);
  const chooserEvent = page.waitForEvent('filechooser');
  await page.getByTestId('attach-button').click();
  const chooser = await chooserEvent;
  // Read the pure policy only to prove this test really obtained a trusted exemption.
  expect(await page.evaluate(async () => {
    const path = '/src/lib/privacy.ts';
    return (await import(path)).privacyLock.suspendedUntil;
  })).toBeGreaterThan(0);
  await chooser.setFiles([]);
  // Some engines model an empty chooser result as cancel rather than change.
  await page.locator('.bc-composer input[type="file"]').dispatchEvent('cancel');
  expect(await page.evaluate(async () => {
    const path = '/src/lib/privacy.ts';
    return (await import(path)).privacyLock.suspendedUntil;
  })).toBe(0);
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  await concealed(page);
});

test('TC-WEB-PRIVACY-020 untrusted synthetic attachment click cannot create an exemption', async ({ page }) => {
  await fixture(page);
  await page.goto('/rooms/ui-design');
  await unlock(page);
  await page.getByTestId('attach-button').dispatchEvent('click');
  expect(await page.evaluate(async () => {
    const path = '/src/lib/privacy.ts';
    return (await import(path)).privacyLock.suspendedUntil;
  })).toBe(0);
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  await concealed(page);
});

for (const width of [360, 1280]) for (const theme of ['light', 'dark'] as const) {
  test(`TC-WEB-PRIVACY-016 ${width}px ${theme} lock screenshot and viewport fit`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 800 });
    await page.emulateMedia({ colorScheme: theme });
    await fixture(page);
    await page.goto('/rooms/ui-design');
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    await concealed(page);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole('button', { name: 'ออกจากระบบ', exact: true })).toBeInViewport();
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/privacy-lock-${width}-${theme}.png`, fullPage: true });
    if (width === 360) {
      await page.setViewportSize({ width, height: 400 });
      await password(page).focus();
      await expect(password(page)).toBeInViewport();
      await page.getByRole('button', { name: 'ปลดล็อก', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'ปลดล็อก', exact: true })).toBeInViewport();
      await page.screenshot({ path: `${shots}/privacy-lock-${width}-${theme}-keyboard-height.png`, fullPage: true });
    }
  });
}


test('TC-WEB-PRIVACY-021 stale false GET cannot undo a cross-tab enable', async ({ page }) => {
  const api = await fixture(page, false);
  await openChat(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/v1/me', async route => {
    const stale = reads++ === 0;
    if (stale) await gate;
    await route.fulfill({ json: { data: { user: { ...me, locale: 'th' }, settings: { notification: { privacy_mode: !stale } } } } });
  });
  const requested = page.waitForRequest('**/api/v1/me');
  await api.emit('user.updated', {}, 'private-user.ui-me');
  await requested;
  await page.evaluate(() => {
    localStorage.setItem('bc.privacy_mode', '1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'bc.privacy_mode', newValue: '1' }));
  });
  await concealed(page);
  const response = page.waitForResponse('**/api/v1/me');
  release();
  await response;
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  // Await the application's promise callbacks before checking the stale response.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await concealed(page);
  expect(await page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBe('1');
});

test('TC-WEB-PRIVACY-022 remote enable masks popups without interrupting typing and locks on return', async ({ page }) => {
  const api = await fixture(page, false);
  await page.addInitScript(() => {
    const notifications: { title: string; options: NotificationOptions }[] = [];
    Object.assign(window, { privacyTestNotifications: notifications });
    Object.defineProperty(window, 'Notification', { configurable: true, value: class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions) { notifications.push({ title, options }); }
      close() {}
    } });
  });
  await openChat(page);
  await page.getByTestId('composer-input').fill('Keep typing');
  api.serverPrivacy(true);
  await api.emit('user.updated', {}, 'private-user.ui-me');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.privacy_mode'))).toBe('1');
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toHaveValue('Keep typing');
  await api.emit('notification.alert', { id: 'remote-privacy-photo', room_id: 'ui-product', kind: 'photo', sound: false }, 'private-user.ui-me');
  await expect.poll(() => page.evaluate(() => (window as Window & { privacyTestNotifications?: unknown[] }).privacyTestNotifications)).toEqual([
    { title: 'Banana Chat', options: { body: 'รูปภาพใหม่', tag: '/rooms/ui-product', renotify: false, silent: true } },
  ]);
  await expect(page).toHaveTitle('Banana Chat');
  await visibility(page, 'hidden');
  await concealed(page);
  await visibility(page, 'visible');
  await concealed(page);
});

for (const width of [360, 1280]) for (const theme of ['light', 'dark'] as const) {
  test(`TC-WEB-PRIVACY-023 ${width}px ${theme} settings toggle screenshot and viewport fit`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 740 : 800 });
    await page.emulateMedia({ colorScheme: theme });
    await fixture(page, false);
    await openChat(page);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.classList.toggle('dark', value === 'dark'); }, theme);
    // On phones the bell lives on the conversation list, not inside a room.
    if (width === 360) await page.getByRole('button', { name: /Back to conversations|กลับไปรายการแชท/ }).click();
    await page.getByTestId('notification-bell').click();
    const toggle = page.getByRole('switch', { name: 'โหมดส่วนตัว' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await mkdir(shots, { recursive: true });
    // The knob must sit inside the track: left edge when off, right edge when on.
    const knobInset = () => toggle.evaluate(el => {
      const track = el.getBoundingClientRect(); const knob = (el.firstElementChild as HTMLElement).getBoundingClientRect();
      return { left: Math.round(knob.left - track.left), right: Math.round(track.right - knob.right) };
    });
    await expect.poll(knobInset).toEqual({ left: 4, right: 24 });
    await page.screenshot({ path: `${shots}/privacy-settings-${width}-${theme}-off.png`, fullPage: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toBeEnabled();
    await expect.poll(knobInset).toEqual({ left: 24, right: 4 });
    await page.screenshot({ path: `${shots}/privacy-settings-${width}-${theme}-on.png`, fullPage: true });
  });
}
