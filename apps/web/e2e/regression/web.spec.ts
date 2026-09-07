import { test, expect } from './fixtures';

/**
 * Web frontend regression — real Vite :5173 → api :8000 → reverb :8088.
 * Realtime AC (FR-MSG-005): a second browser context receives the message
 * over the WebSocket without reload.
 */

const stamp = Date.now().toString(36);

test('login → Engineering room → send → appears in list', async ({ page, uiLogin, shot }) => {
  await uiLogin(page, 'tony', 'Tony12345!');
  await shot(page, '01-logged-in');

  await page.locator('aside').getByText('Engineering').first().click();
  await expect(page.getByTestId('message-list')).toBeVisible();
  await shot(page, '02-room-open');

  const text = `pw-web ${stamp}`;
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('send-button').click();
  await expect(page.getByTestId('message').filter({ hasText: text })).toHaveCount(1, { timeout: 15_000 });
  await shot(page, '03-message-sent');
});

test('realtime — anna sees tony’s message without reload (Reverb WS)', async ({ browser, uiLogin, shot }) => {
  const anna = await browser.newContext();
  const tony = await browser.newContext();
  const annaPage = await anna.newPage();
  const tonyPage = await tony.newPage();

  await uiLogin(annaPage, 'anna', 'Anna12345!');
  await annaPage.locator('aside').getByText('Engineering').first().click();
  await expect(annaPage.getByTestId('message-list')).toBeVisible();
  await shot(annaPage, '01-anna-in-room');

  await uiLogin(tonyPage, 'tony', 'Tony12345!');
  await tonyPage.locator('aside').getByText('Engineering').first().click();
  await expect(tonyPage.getByTestId('message-list')).toBeVisible();

  const text = `pw-realtime ${stamp}`;
  await tonyPage.getByTestId('composer-input').fill(text);
  await tonyPage.getByTestId('send-button').click();

  // anna's page receives it live — no reload (FR-MSG-005)
  await expect(annaPage.getByTestId('message').filter({ hasText: text })).toHaveCount(1, { timeout: 20_000 });
  await shot(annaPage, '02-anna-received-live');
  await shot(tonyPage, '03-tony-sent');

  await anna.close();
  await tony.close();
});

test('search page — finds the message sent earlier (API-080 UI)', async ({ page, uiLogin, shot }) => {
  await uiLogin(page, 'tony', 'Tony12345!');
  await page.getByTestId('open-search').click();
  await expect(page.getByTestId('search-input')).toBeVisible();
  await shot(page, '01-search-open');

  await page.getByTestId('search-input').fill(`pw-web ${stamp}`);
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.getByTestId('search-result-message').first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '02-search-results');
});

test('notification center opens (API-073 UI)', async ({ page, uiLogin, shot }) => {
  await uiLogin(page, 'tony', 'Tony12345!');
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-panel')).toBeVisible();
  await shot(page, '01-notification-panel');
});

test('AI assistant — conversation streams a mock answer (FR-AI-002/003)', async ({ page, uiLogin, shot }) => {
  test.setTimeout(120_000);
  await uiLogin(page, 'tony', 'Tony12345!');
  await page.goto('/ai');
  await shot(page, '01-ai-view');

  // no conversation yet — start one (AI view shows an empty-state until then)
  await page.getByRole('button', { name: '+ แชทใหม่' }).click();

  // consent modal (FR-AI-007) — accept if required (isVisible() doesn't wait,
  // so poll properly for the dialog the 403 triggers)
  const consent = page.getByRole('button', { name: 'ยินยอมและเริ่มใช้' });
  const consentShown = await consent.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
  if (consentShown) {
    await shot(page, '02-consent-dialog');
    await consent.click();
  }

  const input = page.getByPlaceholder(/ถามอะไรก็ได้/);
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  const prompt = `pw-ai ${stamp}`;
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page.getByText(prompt).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, '03-ai-prompt-sent');

  // mock-ai streams a canned reply — wait for the completed bubble
  await expect(page.getByText(/mock provider/).first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1_000);
  await shot(page, '04-ai-answer');
});
