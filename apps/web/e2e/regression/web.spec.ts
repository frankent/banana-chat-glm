import { test, expect } from './fixtures';

/**
 * Web frontend regression — real Vite :5173 → api :8000 → reverb :8088.
 * Realtime AC (FR-MSG-005): a second browser context receives the message
 * over the WebSocket without reload.
 *
 * The "AI assistant" test needs local-only setup not covered by seed/migrate:
 * an `ai_providers` row pointing at `http://mock-ai:8787/v1` (model `mock-glm`),
 * and `AI_ALLOW_PRIVATE_HOSTS=true` in apps/api/.env — otherwise DEC-075's SSRF
 * guard blocks the docker-internal mock-ai host and this suite reports 5/6.
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

  // no conversation yet — start one (DEC-078: AI conversation list lives in
  // AppShell's sidebar now, "new chat" is its compose control)
  await page.locator('.bc-new-chat').click();

  // consent modal (FR-AI-007) — accept if required (isVisible() doesn't wait,
  // so poll properly for the dialog the 403 triggers)
  const consent = page.getByRole('button', { name: 'ยินยอมและเริ่มใช้' });
  const consentShown = await consent.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
  if (consentShown) {
    await shot(page, '02-consent-dialog');
    await consent.click();
  }

  const input = page.getByTestId('ai-composer-input');
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

/**
 * FR-MSG-011 / API-047 / DEC-083 — the only harness that proves the real
 * server contract: attribution survives the round trip and arrives over
 * Reverb in a room the source author is watching, while the copy is sent by
 * the forwarder. TC-WEB-079 covers the dialog against a mocked endpoint.
 */
test('TC-MSG-061 / TC-WEB-079 forward — anna sees somchai’s forward of her message arrive live with “forwarded from Anna”', async ({ browser, uiLogin, shot }) => {
  const anna = await browser.newContext({ locale: 'th-TH' });
  // somchai forwards, not tony: the suite already spends tony's 10-logins/15-min cap (FR-AUTH-006)
  const forwarder = await browser.newContext({ locale: 'th-TH' });
  const annaPage = await anna.newPage();
  const forwarderPage = await forwarder.newPage();
  const text = `pw-forward ${stamp}`;

  await uiLogin(annaPage, 'anna', 'Anna12345!');
  await annaPage.locator('aside').getByText('Engineering').first().click();
  await annaPage.getByTestId('composer-input').fill(text);
  await annaPage.getByTestId('send-button').click();
  await expect(annaPage.getByTestId('message').filter({ hasText: text })).toHaveCount(1, { timeout: 15_000 });
  // anna now watches General, where the forward will land
  await annaPage.locator('aside').getByText('General').first().click();
  await expect(annaPage.getByTestId('message-list')).toBeVisible();

  await uiLogin(forwarderPage, 'somchai', 'Somchai12345!');
  await forwarderPage.locator('aside').getByText('Engineering').first().click();
  const source = forwarderPage.getByTestId('message').filter({ hasText: text });
  await expect(source).toHaveCount(1, { timeout: 15_000 });
  await source.hover();
  await source.locator('.bc-message-actions-toggle').click();
  await forwarderPage.getByTestId('message-actions').getByRole('button', { name: 'ส่งต่อ', exact: true }).click();

  const dialog = forwarderPage.getByTestId('forward-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: /General/ }).check();
  await dialog.getByRole('checkbox', { name: 'Tony Starr', exact: true }).check(); // not the 🔒 secret DM with him
  const [response] = await Promise.all([
    forwarderPage.waitForResponse(r => r.url().endsWith('/api/v1/messages/forward') && r.request().method() === 'POST'),
    dialog.getByRole('button', { name: /ส่งต่อ \(2\)/ }).click(),
  ]);
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  expect(body.data.failed_room_ids).toEqual([]);
  expect(body.data.results).toHaveLength(2);
  for (const result of body.data.results) {
    expect(result.messages[0].body).toBe(text);
    expect(result.messages[0].sender.username).toBe('somchai');
    expect(result.messages[0].forwarded_from.display_name).toBe('Anna Garcia');
  }
  await expect(dialog).toBeHidden();
  await shot(forwarderPage, '01-forwarded');

  // live arrival in anna's open General room, attributed to her, sent by somchai
  const arrived = annaPage.getByTestId('message').filter({ hasText: text });
  await expect(arrived).toHaveCount(1, { timeout: 20_000 });
  await expect(arrived.getByTestId('forwarded-header')).toHaveText(/ส่งต่อจาก Anna Garcia/);
  await shot(annaPage, '02-anna-sees-forward');

  // somchai's own copy in his DM with tony: header shown even though DMs hide sender names, and not editable
  await forwarderPage.locator('aside .bc-room-row').filter({ hasText: 'Tony Starr' }).filter({ hasNot: forwarderPage.getByTestId('secret-room-badge') }).click();
  const copy = forwarderPage.getByTestId('message').filter({ hasText: text });
  await expect(copy.getByTestId('forwarded-header')).toHaveText(/ส่งต่อจาก Anna Garcia/);
  await copy.hover();
  await copy.locator('.bc-message-actions-toggle').click();
  await expect(forwarderPage.getByTestId('message-actions').getByTestId('edit-button')).toHaveCount(0);
  await expect(forwarderPage.getByTestId('message-actions').getByTestId('delete-button')).toBeVisible();
  await shot(forwarderPage, '03-dm-copy');

  await anna.close();
  await forwarder.close();
});
