import { expect, test } from '@playwright/test';
import { installChatFixture } from './fixtures';
import en from '../../../../packages/shared/i18n/en.json' with { type: 'json' };
import th from '../../../../packages/shared/i18n/th.json' with { type: 'json' };

for (const width of [320, 390]) {
  for (const locale of ['en', 'th'] as const) {
    test(`FR-CALL-001 / FR-I18N-001: mobile call labels visible (${width}px, ${locale})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await installChatFixture(page);
      await page.route('**/api/v1/me', async route => {
        // Fully synthetic identity; no live API reads required.
        await route.fulfill({ json: { data: { user: { id: 'ui-me', username: 'ui-tester', display_name: 'Alex', locale }, settings: { locale } } } });
      });
      await page.route('**/api/v1/calls', route => route.fulfill({ json: { data: { enabled: true, calls: [] } } }));
      await page.goto('/rooms/ui-direct');
      await page.locator('.bc-room-tools > summary').click();
      const menu = page.locator('.bc-room-tools-menu');
      const copy = locale === 'th' ? th : en;
      for (const label of [copy['chat.voiceCall'], copy['chat.videoCall'], copy['chat.notes'], copy['chat.files']]) {
        await expect(menu.getByText(label, { exact: true })).toBeVisible();
        await expect(menu.locator('button').filter({ hasText: label }).locator('svg')).toBeVisible();
      }
      // Reintroducing only the deleted rule reproduces the original specificity bug.
      const originalRule = await page.addStyleTag({ content: '@media (max-width: 1050px) { #root .bc-chat-header .bc-call-label { display: none; } }' });
      await expect(menu.getByText(copy['chat.voiceCall'], { exact: true })).not.toBeVisible();
      await originalRule.evaluate(el => el.remove());
      await expect(menu.getByText(copy['chat.voiceCall'], { exact: true })).toBeVisible();
    });
  }
}

for (const width of [390, 1440]) {
  test(`FR-ROOM-012: ${width}px explicit expiry, fallback peer, retry and navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installChatFixture(page);
    await page.route('**/api/v1/rooms/ui-direct', route => route.fulfill({ json: { data: {
      room: { id: 'ui-direct', type: 'dm', member_count: 2, last_seq: 40 }, other_user: null, my_role: 'member',
    } } }));
    const requests: unknown[] = [];
    let release: (() => void) | undefined;
    await page.route('**/api/v1/rooms', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Try again' } } });
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { data: { room: { id: 'ui-secret' } } } });
    });
    await page.goto('/rooms/ui-direct');
    await page.locator('.bc-room-tools > summary').click();
    await page.getByRole('button', { name: th['chat.openSecretChat'] }).click();
    await expect(page.locator('.bc-room-tools')).not.toHaveAttribute('open');
    const dialog = page.getByRole('dialog', { name: th['chat.openSecretChat'] });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(th['room.secret.explain'])).toBeVisible();
    await expect(dialog.getByRole('combobox')).toHaveValue('7');
    await expect(dialog.locator('option')).toHaveCount(30);
    expect(requests).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(requests).toEqual([]);
    await page.locator('.bc-room-tools > summary').click();
    await page.getByRole('button', { name: th['chat.openSecretChat'] }).click();
    await dialog.getByRole('combobox').selectOption('3');
    await dialog.getByRole('button', { name: th['chat.openSecretChat'] }).click();
    await expect(dialog.getByRole('alert')).toContainText('Try again');
    expect(requests[0]).toEqual({ type: 'dm', user_id: 'ui-peer', secret: true, expiry_days: 3 });
    await dialog.getByRole('button', { name: th['chat.openSecretChat'] }).click();
    await expect(dialog.getByRole('combobox')).toBeDisabled();
    await expect.poll(() => requests.length).toBe(2);
    release!();
    await expect(page).toHaveURL(/\/rooms\/ui-secret$/);
  });
}

test('FR-ROOM-012: shortcut hidden in groups and active secret DMs', async ({ page }) => {
  await installChatFixture(page);
  await page.goto('/rooms/ui-design');
  await page.locator('.bc-room-tools > summary').click();
  await expect(page.getByRole('button', { name: th['chat.openSecretChat'] })).toHaveCount(0);
  await page.route('**/api/v1/rooms/ui-direct', route => route.fulfill({ json: { data: {
    room: { id: 'ui-direct', type: 'dm', is_secret: true, secret_expires_at: '2099-01-01T00:00:00Z', member_count: 2, last_seq: 40 },
    other_user: { id: 'ui-peer', display_name: 'Peer' }, my_role: 'member',
  } } }));
  await page.goto('/rooms/ui-direct');
  await expect(page.getByTestId('secret-expiry-header')).toBeVisible();
  await page.locator('.bc-room-tools > summary').click();
  await expect(page.getByRole('button', { name: th['chat.openSecretChat'] })).toHaveCount(0);
});
