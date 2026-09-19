import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

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
