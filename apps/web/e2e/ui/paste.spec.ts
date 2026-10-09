import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { grantClipboard, pasteFiles, readPng, writeClipboard } from './clipboard';
import { installChatFixture, openChat } from './fixtures';

/**
 * FR-MEDIA-001 / DEC-099 — pasting an image into the composer.
 *
 * What these tests are careful about (the first version of this suite was green while the chip
 * was sitting in an ERROR state, because nothing checked status and the upload was never mocked):
 *  - the upload pipeline is mocked end to end, so a chip must really reach `ready`;
 *  - every test reads back what the page asked for (ticket body, bytes PUT, completes, the
 *    message POST) instead of only checking that "something" appeared;
 *  - the paste is a REAL keyboard paste of a REAL clipboard payload wherever the clipboard API
 *    allows it. The two cases that need a chosen file NAME use a `paste` event dispatched on the
 *    focused textarea (see clipboard.ts).
 */

const SHORTCUT = 'ControlOrMeta+V';
const GENERATED_NAME = /^pasted-\d{6}(-\d+)?\.png$/;

const input = (page: Page) => page.getByTestId('composer-input');
const chips = (page: Page) => page.getByTestId('composer-attachment');

async function openComposer(page: Page) {
  await grantClipboard(page.context());
  const chat = await installChatFixture(page, { uploads: true });
  await openChat(page);
  await input(page).click();
  return chat;
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots', name) });
}

test.describe('FR-MEDIA-001 / DEC-099 paste an image into the composer', () => {
  test('TC-WEB-PASTE-001 a pasted screenshot becomes a ready, readable, uploaded chip', async ({ page }, testInfo) => {
    const chat = await openComposer(page);
    const png = await readPng();

    await writeClipboard(page, { png });
    await page.keyboard.press(SHORTCUT);

    await expect(chips(page)).toHaveCount(1);
    const chip = chips(page).first();
    await expect(chip).toHaveAttribute('data-status', 'ready');
    await expect(chip).toContainText('พร้อมส่ง');
    await expect(chip.locator('img')).toBeVisible();

    const label = (await chip.locator('img').getAttribute('alt')) ?? '';
    expect(label, 'a clipboard screenshot gets a short timestamped label, not the generic "image.png"').toMatch(GENERATED_NAME);
    await expect(input(page), 'pasting an image must not insert text').toHaveValue('');

    // The whole pipeline ran: ticket → storage PUT → complete. The size on the ticket must equal the
    // bytes actually uploaded (the server rejects a mismatch). It is NOT the source file's size:
    // Chromium re-encodes an image that has been through the clipboard.
    expect(chat.uploadRequests).toHaveLength(1);
    const [ticket] = chat.uploadRequests;
    expect(ticket).toMatchObject({ kind: 'image', filename: label, mime_type: 'image/png' });
    expect(ticket!.size_bytes).toBeGreaterThan(0);
    expect(chat.storagePuts).toEqual([{ attachmentId: 'ui-att-1', bytes: ticket!.size_bytes }]);
    expect(chat.completeRequests).toEqual(['ui-att-1']);

    await shot(page, testInfo, 'paste-001-ready-chip-desktop.png');
  });

  test('TC-WEB-PASTE-002 sending after a paste posts the uploaded attachment and clears the chip', async ({ page }) => {
    const chat = await openComposer(page);
    await writeClipboard(page, { png: await readPng() });
    await page.keyboard.press(SHORTCUT);
    await expect(chips(page).first()).toHaveAttribute('data-status', 'ready');

    await page.getByTestId('send-button').click();

    await expect.poll(() => chat.sentMessages.length).toBe(1);
    expect(JSON.stringify(chat.sentMessages[0]), 'the message must reference the pasted attachment').toContain('ui-att-1');
    await expect(chips(page)).toHaveCount(0);
  });

  test('TC-WEB-PASTE-003 an image file copied from a folder keeps its own name', async ({ page }) => {
    const chat = await openComposer(page);

    await pasteFiles(page, [{ name: 'Holiday-Photo.png', type: 'image/png', bytes: await readPng() }]);

    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toHaveAttribute('data-status', 'ready');
    await expect(chips(page).first()).toContainText('Holiday-Photo.png');
    expect(chat.uploadRequests.map((request) => request.filename)).toEqual(['Holiday-Photo.png']);
  });

  test('TC-WEB-PASTE-004 browser "Copy image" (html + image, no plain text) attaches and inserts no markup', async ({ page }) => {
    const chat = await openComposer(page);

    await writeClipboard(page, { html: '<img src="https://example.com/cat.png">', png: await readPng() });
    await page.keyboard.press(SHORTCUT);

    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).first()).toHaveAttribute('data-status', 'ready');
    await expect(input(page)).toHaveValue('');
    expect(chat.uploadRequests).toHaveLength(1);
  });

  test('TC-WEB-PASTE-005 cells copied from a spreadsheet (text + html + a picture of them) paste as text only', async ({ page }) => {
    const chat = await openComposer(page);

    await writeClipboard(page, {
      plain: 'A1\tB1\nA2\tB2',
      html: '<table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>',
      png: await readPng(),
    });
    await page.keyboard.press(SHORTCUT);

    await expect(input(page), 'the text is what the user copied').toHaveValue('A1\tB1\nA2\tB2');
    await expect(chips(page)).toHaveCount(0);
    expect(chat.uploadRequests, 'nothing may be uploaded behind the user\'s back').toHaveLength(0);
  });

  test('TC-WEB-PASTE-006 pasting plain text is unchanged', async ({ page }) => {
    const chat = await openComposer(page);

    await writeClipboard(page, { plain: 'ธุรกรรม 12345' });
    await page.keyboard.press(SHORTCUT);

    await expect(input(page)).toHaveValue('ธุรกรรม 12345');
    await expect(chips(page)).toHaveCount(0);
    expect(chat.uploadRequests).toHaveLength(0);
  });

  test('TC-WEB-PASTE-007 two screenshots pasted back to back are told apart', async ({ page }) => {
    const chat = await openComposer(page);
    const png = await readPng();

    await writeClipboard(page, { png });
    await page.keyboard.press(SHORTCUT);
    await expect(chips(page)).toHaveCount(1);
    await writeClipboard(page, { png });
    await page.keyboard.press(SHORTCUT);
    await expect(chips(page)).toHaveCount(2);

    const names = chat.uploadRequests.map((request) => request.filename);
    expect(new Set(names.map((name) => name.toLowerCase())).size, `names must differ: ${names.join(', ')}`).toBe(2);
    for (const name of names) expect(name).toMatch(GENERATED_NAME);
  });

  test('TC-WEB-PASTE-008 several images in ONE paste all attach, each with its own label', async ({ page }) => {
    const chat = await openComposer(page);
    const bytes = await readPng();

    // Browsers give every clipboard image the same placeholder name.
    await pasteFiles(page, [
      { name: 'image.png', type: 'image/png', bytes },
      { name: 'image.png', type: 'image/png', bytes },
      { name: 'image.png', type: 'image/png', bytes },
    ]);

    await expect(chips(page)).toHaveCount(3);
    const names = chat.uploadRequests.map((request) => request.filename);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(GENERATED_NAME);
  });

  test('TC-WEB-PASTE-009 pasting into another field, or with nothing focused, never touches the composer', async ({ page }) => {
    const chat = await openComposer(page);
    await page.evaluate(() => {
      const other = document.createElement('input');
      other.id = 'outside-composer';
      other.setAttribute('aria-label', 'outside');
      document.body.append(other);
    });

    await writeClipboard(page, { png: await readPng() });
    await page.locator('#outside-composer').focus();
    await page.keyboard.press(SHORTCUT);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(SHORTCUT);
    await page.waitForTimeout(300);

    await expect(chips(page)).toHaveCount(0);
    expect(chat.uploadRequests).toHaveLength(0);
  });

  test('TC-WEB-PASTE-010 a pasted file that is not an image is not picked up by paste', async ({ page }) => {
    const chat = await openComposer(page);

    await pasteFiles(page, [{ name: 'report.pdf', type: 'application/pdf' }]);
    await page.waitForTimeout(300);

    await expect(chips(page)).toHaveCount(0);
    expect(chat.uploadRequests).toHaveLength(0);
  });

  test('TC-WEB-PASTE-011 an image pasted next to a PDF attaches only the image', async ({ page }) => {
    const chat = await openComposer(page);

    await pasteFiles(page, [
      { name: 'report.pdf', type: 'application/pdf' },
      { name: 'chart.png', type: 'image/png', bytes: await readPng() },
    ]);

    await expect(chips(page)).toHaveCount(1);
    expect(chat.uploadRequests.map((request) => request.filename)).toEqual(['chart.png']);
  });

  test('TC-WEB-PASTE-012 a pasted image never makes a phone-width composer scroll sideways', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const chat = await openComposer(page);

    await pasteFiles(page, [
      { name: 'a-very-long-photo-name-from-the-camera-roll-that-keeps-going-and-going-2026-10-09.png', type: 'image/png', bytes: await readPng() },
      { name: 'image.png', type: 'image/png', bytes: await readPng() },
    ]);
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).first()).toHaveAttribute('data-status', 'ready');

    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      row: (() => {
        const row = document.querySelector('[data-testid="composer-attachments"]') as HTMLElement | null;
        return row ? row.scrollWidth - row.clientWidth : -1;
      })(),
    }));
    expect(overflow.page, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
    expect(overflow.row, 'the chip row must wrap, not scroll').toBeLessThanOrEqual(0);
    expect(chat.uploadRequests).toHaveLength(2);

    await shot(page, testInfo, 'paste-012-chips-phone-390.png');
  });

  for (const width of [390, 320]) {
    test(`TC-WEB-PASTE-013 at ${width}px two pasted screenshots can be told apart by what is actually VISIBLE`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 });
      await openComposer(page);
      const bytes = await readPng();

      await pasteFiles(page, [
        { name: 'image.png', type: 'image/png', bytes },
        { name: 'image.png', type: 'image/png', bytes },
      ]);
      await expect(chips(page)).toHaveCount(2);
      await expect(chips(page).nth(1)).toHaveAttribute('data-status', 'ready');

      // The chip clips long names with an ellipsis. A label whose distinguishing part is hidden by
      // that ellipsis is unique in the DOM but identical to the eye — the defect this test pins.
      const labels = await page.getByTestId('composer-attachment').evaluateAll((nodes) =>
        nodes.map((node) => {
          const text = node.querySelector('span.truncate') as HTMLElement;
          return { shown: text.firstChild?.textContent ?? '', clipped: text.scrollWidth > text.clientWidth };
        }),
      );
      expect(labels.map((label) => label.clipped), `labels at ${width}px: ${JSON.stringify(labels)}`).toEqual([false, false]);
      expect(new Set(labels.map((label) => label.shown)).size, 'the two visible labels must differ').toBe(2);

      await shot(page, testInfo, `paste-013-distinct-labels-${width}.png`);
    });
  }
});
