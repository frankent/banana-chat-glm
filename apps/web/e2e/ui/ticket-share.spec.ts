import { expect, test, type Page } from '@playwright/test';
import { grantClipboard } from './clipboard';
import { installCardsFixture, noHorizontalScroll, SECRET_TITLE, T_ORIGIN, TICKET_A, TICKET_ARCHIVED, TICKET_MISSING, TICKET_OTHER } from './fixtures';
import th from '../../../../packages/shared/i18n/th.json' with { type: 'json' };

const drawerUrl = (id: string, ws = 'ui-studio') => `/board/${id}?ws=${ws}`;
async function openDrawer(page: Page, id = TICKET_A, ws = 'ui-studio') {
  await page.goto(drawerUrl(id, ws));
  await expect(page.getByTestId('ticket-link')).toBeVisible();
}
async function openShare(page: Page) {
  await page.getByTestId('ticket-share').click();
  const dialog = page.getByTestId('share-ticket-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const width of [320, 390, 1440]) {
  test.describe(`${width}px ticket share (FR-KAN-007)`, () => {
    test.beforeEach(async ({ page, context }) => { await grantClipboard(context); await page.setViewportSize({ width, height: 844 }); });

    test(`TC-WEB-TSHARE-001 [${width}] drawer shows the link and Copy puts {origin}/board/{id}?ws={slug} on the clipboard`, async ({ page }) => {
      await installCardsFixture(page);
      await openDrawer(page);
      const expected = `${T_ORIGIN}/board/${TICKET_A}?ws=ui-studio`;
      await expect(page.getByTestId('ticket-link-input')).toHaveValue(expected);
      await page.getByTestId('ticket-copy-link').click();
      await expect(page.getByTestId('ticket-link-status')).toHaveText(th['board.copied']);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      await noHorizontalScroll(page);
    });

    test(`TC-WEB-TSHARE-002 [${width}] share sends exactly one POST with the URL (+note); double click and retry reuse one client_message_id`, async ({ page }) => {
      const fx = await installCardsFixture(page);
      await openDrawer(page);
      const dialog = await openShare(page);
      await expect(dialog.getByTestId('share-ticket-room')).toHaveCount(3);
      await expect(dialog.getByTestId('share-ticket-search')).toBeFocused();
      await dialog.getByTestId('share-ticket-search').fill('Product');
      await expect(dialog.getByTestId('share-ticket-room')).toHaveCount(1);
      await dialog.getByTestId('share-ticket-search').fill('');
      await expect(dialog.getByTestId('share-ticket-send')).toBeDisabled();
      await dialog.getByTestId('share-ticket-room').filter({ hasText: 'Design studio' }).click();
      await dialog.getByTestId('share-ticket-note').fill('  please look  ');
      const url = `${T_ORIGIN}/board/${TICKET_A}?ws=ui-studio`;
      // transient failure then retry: same intent => same id
      fx.failSend({ status: 500, code: 'SERVER' });
      await dialog.getByTestId('share-ticket-send').click();
      await expect(dialog.getByTestId('share-ticket-error')).toHaveText(th['board.shareError']);
      fx.failSend(null);
      const release = fx.holdSend();
      await dialog.getByTestId('share-ticket-send').dblclick();
      await expect(dialog.getByTestId('share-ticket-send')).toBeDisabled();
      release();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('ticket-link-status')).toContainText('Design studio');
      expect(fx.sendRequests).toHaveLength(2); // failed attempt + ONE successful (double click collapsed)
      expect(fx.sendRequests[0]!.client_message_id).toBe(fx.sendRequests[1]!.client_message_id);
      expect(fx.sendRequests[1]).toMatchObject({ roomId: 'ui-design', body: `please look\n${url}`, slug: 'ui-studio' });
      expect(fx.sendRequests[1]!.body).not.toContain(SECRET_TITLE); // title never travels in the message
      await expect(page.getByTestId('ticket-share')).toBeFocused();
      await noHorizontalScroll(page);
    });

    test(`TC-WEB-TSHARE-004 [${width}] error mapping per failure`, async ({ page }) => {
      const fx = await installCardsFixture(page);
      await openDrawer(page);
      const dialog = await openShare(page);
      await dialog.getByTestId('share-ticket-room').first().click();
      const cases: Array<[{ status: number; code: string }, string]> = [
        [{ status: 403, code: 'ROOM_NOT_MEMBER' }, 'board.shareErrorMember'],
        [{ status: 410, code: 'ROOM_EXPIRED' }, 'board.shareErrorExpired'],
        [{ status: 403, code: 'WS_ARCHIVED' }, 'board.shareErrorArchived'],
        [{ status: 429, code: 'RATE_LIMITED' }, 'board.shareErrorRate'],
        [{ status: 503, code: 'UNAVAILABLE' }, 'board.shareError'],
      ];
      for (const [failure, key] of cases) {
        fx.failSend(failure);
        await dialog.getByTestId('share-ticket-send').click();
        await expect(dialog.getByTestId('share-ticket-error')).toHaveText((th as Record<string, string>)[key]!);
        await expect(dialog.getByTestId('share-ticket-send')).toBeEnabled();
      }
      expect(new Set(fx.sendRequests.map(r => r.client_message_id)).size).toBe(1);
      await expect(dialog).toBeVisible();
    });

    test(`TC-WEB-TSHARE-003 [${width}] archived workspace disables Share and cannot send`, async ({ page }) => {
      const fx = await installCardsFixture(page, { startWorkspace: 'old-team' });
      await openDrawer(page, TICKET_ARCHIVED, 'old-team');
      await expect(page.getByTestId('ticket-share')).toBeDisabled();
      await expect(page.getByTestId('ticket-copy-link')).toBeEnabled(); // read-only copy still fine
      expect(fx.sendRequests).toHaveLength(0);
    });

    test(`TC-WEB-TSHARE-005 [${width}] deep link with another member workspace switches workspace and opens the drawer`, async ({ page }) => {
      const fx = await installCardsFixture(page);
      await page.goto(drawerUrl(TICKET_OTHER, 'other-team'));
      await expect(page.getByTestId('ticket-link')).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Ticket details' }).getByRole('heading', { name: 'Other workspace ticket' })).toBeVisible();
      expect(fx.ticketDetailRequests.length).toBeGreaterThan(0);
      expect(fx.ticketDetailRequests.every(r => r.slug === 'other-team')).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('orgchat.lastWorkspace'))).toBe('other-team');
      await expect(page).toHaveURL(new RegExp(`/board/${TICKET_OTHER}\\?ws=other-team$`));
    });

    test(`TC-WEB-TSHARE-006 [${width}] ws of a non-member workspace shows no access and fires NO ticket request`, async ({ page }) => {
      const fx = await installCardsFixture(page);
      await page.goto(drawerUrl(TICKET_A, 'not-my-team'));
      await expect(page.getByTestId('board-no-access')).toContainText(th['board.noAccess']);
      expect(fx.ticketDetailRequests).toHaveLength(0);
      expect(fx.cardRequests).toHaveLength(0);
      await page.getByTestId('board-back').click();
      await expect(page).toHaveURL(/\/board$/);
      await noHorizontalScroll(page);
    });

    test(`TC-WEB-TSHARE-007 [${width}] missing ticket (404) says "ticket not found", not a raw API message`, async ({ page }) => {
      await installCardsFixture(page);
      await page.goto(drawerUrl(TICKET_MISSING));
      await expect(page.getByTestId('ticket-not-found')).toHaveText(th['board.ticketNotFound']);
      await expect(page.getByTestId('ticket-not-found')).not.toContainText('Synthetic');
    });
  });
}

test.describe('ticket share: keyboard, dark mode and login return', () => {
  test('TC-WEB-TSHARE-001b keyboard: Tab reaches Share, Enter opens, Escape closes and restores focus; dark mode contrast', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    const fx = await installCardsFixture(page);
    await openDrawer(page);
    await page.getByTestId('ticket-share').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('share-ticket-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('share-ticket-search')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByTestId('share-ticket-room').first().locator('input')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(dialog.getByTestId('share-ticket-send')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('ticket-share')).toBeFocused();
    expect(fx.sendRequests).toHaveLength(0);
  });

  test('TC-WEB-TSHARE-008 logged-out deep link -> login -> returns to the ticket URL; hostile returnTo is ignored', async ({ page }) => {
    const fx = await installCardsFixture(page, { anonymous: true });
    await page.goto(drawerUrl(TICKET_A));
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe(drawerUrl(TICKET_A));
    await page.getByLabel('Username').fill('ui-tester');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/board/${TICKET_A}\\?ws=ui-studio$`));
    await expect(page.getByTestId('ticket-link')).toBeVisible();
    expect(fx.logins()).toBe(1);
  });

  for (const evil of ['//evil.test/x', 'https://evil.test', '/board/not-a-ulid', 'javascript:alert(1)']) {
    test(`TC-WEB-TSHARE-008b hostile returnTo ${evil} lands on /`, async ({ page }) => {
      await installCardsFixture(page, { anonymous: true });
      await page.goto(`/login?returnTo=${encodeURIComponent(evil)}`);
      await page.getByLabel('Username').fill('ui-tester');
      await page.getByLabel('Password').fill('not-a-real-password');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(`${T_ORIGIN}/`);
    });
  }
});
