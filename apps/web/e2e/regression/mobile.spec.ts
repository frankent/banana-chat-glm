import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import th from '../../../../packages/shared/i18n/th.json' with { type: 'json' };

/**
 * DEC-058 / TC-WEB-071 — mobile browser composer auto-zoom regression.
 *
 * iOS Safari (and Chromium's mobile emulation) zoom the page when an editable
 * control with a computed font-size under 16px receives focus. The chat composer
 * was 13px, so every tap made the whole conversation jump. The fix pins a 16px
 * floor on editable controls under `@media (pointer: coarse)`. These checks run
 * in an explicitly created touch/mobile context so they work from any project.
 *
 * Coverage note: this is a computed-font-size invariant, not a live zoom test.
 * Chromium's `isMobile` emulation does not reproduce iOS Safari's focus
 * auto-zoom, and no project here runs a real WebKit/iOS device, so the sweep
 * below IS the regression guard — hence the negative probe that proves the
 * sweep can fail. DEC-058 names composer, login, tickets, notes and the meeting
 * lobby, so every one of those surfaces is opened and measured.
 */

/** Every visible editable control whose computed font-size would trigger focus zoom. */
async function collectZoomOffenders(page: Page): Promise<{ name: string; fontSize: string }[]> {
  return page.evaluate(() => {
    // Matches index.css: any editable host, not only contenteditable="true"
    // (a bare `contenteditable` and `plaintext-only` are equally editable), and
    // the same non-textual input types the floor excludes — checkboxes/radios/
    // buttons/files never trigger iOS focus zoom, so a 14px secret-toggle
    // checkbox (NewRoomDialog) is not an offender.
    const controls = Array.from(
      document.querySelectorAll(
        'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="image"]):not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"])',
      ),
    );
    return controls
      .filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .map((el) => ({
        name: el.getAttribute('data-testid') ?? el.getAttribute('name') ?? el.getAttribute('aria-label') ?? `${el.tagName.toLowerCase()}#${el.id}`,
        fontSize: window.getComputedStyle(el).fontSize,
      }))
      .filter((c) => parseFloat(c.fontSize) < 16);
  });
}

/** Fails with a per-control report when any visible editable control can trigger zoom. */
async function expectEditableFontsAtLeast16(page: Page, surface: string): Promise<void> {
  const offenders = await collectZoomOffenders(page);
  expect(offenders, `${surface}: editable controls under 16px would auto-zoom on focus`).toEqual([]);
}

test('mobile — login and composer editable controls never trigger focus auto-zoom (DEC-058)', async ({ browser, uiLogin, shot }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: 'th-TH',
  });
  const page = await context.newPage();

  // Guard: this test only means something with a coarse primary pointer.
  await page.goto('/');
  expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches), 'emulated device must report a coarse pointer').toBe(true);

  // Pinch zoom must stay available: no user-scalable=no / maximum-scale lock, and the
  // Android keyboard mode that keeps the composer visible is present (DEC-058).
  const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewportMeta, 'viewport meta').toBeTruthy();
  expect(viewportMeta!, 'pinch zoom must stay enabled (no user-scalable=no)').not.toMatch(/user-scalable\s*=\s*no/i);
  expect(viewportMeta!, 'pinch zoom must stay enabled (no maximum-scale lock)').not.toMatch(/maximum-scale\s*=\s*1(\.0+)?\s*(,|$)/i);
  expect(viewportMeta!, 'Android keyboard resizes the layout so the composer stays visible').toContain('interactive-widget=resizes-content');

  await expectEditableFontsAtLeast16(page, 'login page');
  await shot(page, '01-login-mobile');

  await uiLogin(page, 'tony', 'Tony12345!');

  // The room-list compose control now collapses the +DM/+Group panel behind a
  // single toggle (locale-driven aria-label, so target it by class); opening
  // it is a precondition for reaching NewRoomDialog's own +Group/+DM buttons.
  await page.locator('.bc-new-chat').click();

  // NewRoomDialog collapses to two buttons until expanded, so its inputs are not
  // in the DOM for the sweep until we open it. The sidebar is still open here;
  // once a room is selected it is hidden at this width (index.css:158).
  const newRoom = page.locator('.bc-new-room');
  await newRoom.getByRole('button', { name: '+ Group' }).click();
  await expect(page.getByPlaceholder('Group name')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'new room dialog');
  await newRoom.getByRole('button', { name: '✕' }).click();

  await page.locator('aside').getByText('Engineering').first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  await expectEditableFontsAtLeast16(page, 'room view');
  await shot(page, '02-composer-mobile');

  // The sweep must be able to FAIL, otherwise it guards nothing: reintroduce the
  // pre-fix 13px composer and confirm it is reported, then remove the probe.
  // An injected `.bc-compose-box textarea` rule outranks the floor's bare
  // `textarea` selector, so this genuinely defeats index.css.
  const probe = await page.addStyleTag({ content: '.bc-compose-box textarea { font-size: 13px !important; }' });
  const probed = await collectZoomOffenders(page);
  expect(probed.length, 'the 16px sweep must detect a sub-16px composer, or it proves nothing').toBeGreaterThan(0);
  await probe.evaluate((el) => (el as Element).remove());
  await expectEditableFontsAtLeast16(page, 'room view (probe removed)');

  // Room notes: a separate panel with its own compose textarea (DEC-058).
  // Notes/media are now behind a single room-tools disclosure.
  await page.locator('.bc-room-tools summary').click();
  await page.getByRole('button', { name: 'Room notes' }).click();
  await expect(page.getByLabel('Note text')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'room notes');
  await page.getByRole('button', { name: 'Close notes' }).click();

  // Focusing the composer must not change the page scale (the pre-fix trigger:
  // sub-16px controls zoom on focus). Tolerates keyboards that pan the viewport.
  const scaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  await page.getByTestId('composer-input').tap();
  await page.getByTestId('composer-input').fill('mobile regression');
  const scaleAfter = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  expect(scaleAfter, 'focusing the composer must not zoom the page').toBe(scaleBefore);
  await shot(page, '03-composer-focused');

  // Remaining DEC-058 surfaces. Each waits on a control that renders regardless
  // of seed data, so these stay stable without fixtures of their own.
  await page.goto('/search');
  await expect(page.getByTestId('search-input')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'search page');

  await page.goto('/members');
  await expect(page.getByLabel('Search workspace members')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'members directory');

  await page.goto('/meetings');
  await expect(page.getByPlaceholder('Project catch-up')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'meetings lobby');
  await shot(page, '04-meetings-mobile');

  // The board is the densest mobile surface — the floor lifts every ticket-card
  // lane select from 10px to 16px, so the shot exists to review that density.
  await page.goto('/board');
  await expect(page.getByLabel('Search tickets')).toBeVisible();
  await expectEditableFontsAtLeast16(page, 'workspace board');
  await shot(page, '05-board-mobile');

  await context.close();
});

/**
 * FR-ROOM-012 — mobile room-tools "..." menu shortcut that opens a separate
 * secret (auto-deleting) DM alongside an ordinary one. Only a live run can
 * prove the CREATE contract end to end: apps/web/e2e/ui/room-tools.spec.ts
 * proves the dialog/labels/gating against a mocked POST /api/v1/rooms, but
 * the server's dm_key dedupe (CreateRoomAction::createDm) — the thing that
 * makes repeated clicks land on the SAME secret room instead of spawning a
 * new one every time — only exists in the real API.
 *
 * Uses the DatabaseSeeder tony↔somchai DM (ordinary, non-secret) as the
 * starting room. The secret DM this test creates dedupes on tony+somchai
 * (dm_key is independent of the chosen expiry), so re-running this test
 * against the same seeded DB reuses the same secret room rather than
 * accumulating new ones — hence asserting `is_secret===true` off the
 * response body instead of asserting 201 on the first click.
 */
test('secret chat shortcut creates a separate room then dedupes on repeat click (FR-ROOM-012)', async ({ browser, uiLogin }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'th-TH',
  });
  const page = await context.newPage();
  await uiLogin(page, 'tony', 'Tony12345!');

  // Seeded ordinary DM: tony ↔ somchai (สมชาย ใจดี). The room list is only
  // visible pre-selection at this width (index.css:158). On a re-run of this
  // test the secret DM this test creates ALSO shows "สมชาย ใจดี" in the list
  // (same peer, no distinguishing name) — the ordinary DM is the row WITHOUT
  // the secret-room-badge testid, so filter on that rather than `.first()`.
  const dmRow = page.locator('aside .bc-room-row')
    .filter({ hasText: 'สมชาย ใจดี' })
    .filter({ hasNot: page.getByTestId('secret-room-badge') });
  await expect(dmRow).toHaveCount(1);
  await dmRow.click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const dmUrl = page.url();

  const openDialogAndConfirm = async () => {
    await page.locator('.bc-room-tools > summary').click();
    await page.getByRole('button', { name: th['chat.openSecretChat'] }).click();
    const dialog = page.getByRole('dialog', { name: th['chat.openSecretChat'] });
    await expect(dialog).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/v1/rooms') && r.request().method() === 'POST'),
      dialog.getByRole('button', { name: th['chat.openSecretChat'] }).click(),
    ]);
    return { dialog, response };
  };

  // 1. Create (or, on a re-run against the same DB, dedupe onto the
  // already-existing secret room — either way this is a real server round trip).
  const first = await openDialogAndConfirm();
  expect([200, 201], `unexpected status creating the secret DM: ${await first.response.text()}`).toContain(first.response.status());
  const created = (await first.response.json()).data.room;
  expect(created.is_secret).toBe(true);
  await expect(first.dialog).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/rooms/${created.id}$`));
  expect(page.url()).not.toBe(dmUrl);
  await expect(page.getByTestId('secret-expiry-header')).toBeVisible();

  // Secret DM active ⇒ the shortcut itself must now be hidden on that room.
  await page.locator('.bc-room-tools > summary').click();
  await expect(page.getByRole('button', { name: th['chat.openSecretChat'] })).toHaveCount(0);

  // 2. Back to the ordinary DM, click the shortcut again — must land on the
  // SAME secret room (server dedupe), not create a second one.
  await page.goto(dmUrl);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const second = await openDialogAndConfirm();
  expect(second.response.status(), 'repeat click must dedupe (200), not create a second room').toBe(200);
  const reused = (await second.response.json()).data.room;
  expect(reused.id).toBe(created.id);
  await expect(page).toHaveURL(new RegExp(`/rooms/${created.id}$`));

  await context.close();
});
