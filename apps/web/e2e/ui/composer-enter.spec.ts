import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installChatFixture, openChat } from './fixtures';

/**
 * FR-COMP-001 / DEC-106 — the composer can make Enter insert a newline; Ctrl/Cmd+Enter then sends.
 * The choice is stored per browser (localStorage), so it survives a reload but not another device.
 */

const input = (page: Page) => page.getByTestId('composer-input');
const toggle = (page: Page) => page.getByTestId('enter-sends-toggle');

async function openComposer(page: Page) {
  const chat = await installChatFixture(page);
  await openChat(page);
  await input(page).click();
  return chat;
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots', name) });
}

test.describe('FR-COMP-001 / DEC-106 Enter sends or inserts a newline', () => {
  test('TC-UI-COMP-001 default Enter sends, and the toggle is off by default', async ({ page }) => {
    const chat = await openComposer(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

    await input(page).fill('hello');
    await input(page).press('Enter');

    await expect.poll(() => chat.sentMessages.length).toBe(1);
    await expect(input(page)).toHaveValue('');
  });

  test('TC-UI-COMP-002 with the toggle off, Enter adds a newline and Ctrl+Enter sends', async ({ page }, testInfo) => {
    const chat = await openComposer(page);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.bc-compose-hint')).toContainText('Ctrl');

    await input(page).fill('line one');
    await input(page).press('Enter');
    await expect(input(page)).toHaveValue('line one\n');
    expect(chat.sentMessages, 'Enter alone must not send in newline mode').toHaveLength(0);

    await input(page).type('line two');
    await shot(page, testInfo, 'composer-enter-newline-mode.png');
    await input(page).press('ControlOrMeta+Enter');

    await expect.poll(() => chat.sentMessages.length).toBe(1);
    expect(JSON.stringify(chat.sentMessages[0])).toContain('line one');
  });

  test('TC-UI-COMP-003 the choice is kept in this browser across a reload', async ({ page }) => {
    await openComposer(page);
    await toggle(page).click();

    await expect.poll(() => page.evaluate(() => localStorage.getItem('bc.composer.enterSends'))).toBe('false');

    await page.reload();
    await openChat(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  });
});
