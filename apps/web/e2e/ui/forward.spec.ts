import { expect, test, type Page } from '@playwright/test';
import { installChatFixture, openChat } from './fixtures';
import th from '../../../../packages/shared/i18n/th.json' with { type: 'json' };

async function openForward(page: Page, seq = 40) {
  const trigger = page.locator(`[data-seq="${seq}"] .bc-message-actions-toggle`);
  await trigger.click();
  await page.getByTestId('message-actions').getByRole('button', { name: 'ส่งต่อ', exact: true }).click();
  const dialog = page.getByTestId('forward-dialog');
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

for (const width of [390, 1440]) {
  test.describe(`${width}px forward messages`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 844 }); });

    test('TC-WEB-078: attribution in group and DM, deleted suppression and own edit guard', async ({ page }) => {
      await installChatFixture(page, { forwarding: true });
      await openChat(page);
      for (const seq of [35, 36]) await expect(page.locator(`[data-seq="${seq}"]`).getByTestId('forwarded-header')).toHaveText(/ส่งต่อจาก Original Author/);
      // Positive control for the exact sender locator used in the DM below.
      await expect(page.locator('[data-seq="35"] .bc-message-bubble > p.font-semibold')).toHaveText('มินตรา Chen');
      for (const seq of [35, 36]) {
        const colors = await page.locator(`[data-seq="${seq}"]`).getByTestId('forwarded-header').evaluate(header => ({
          text: getComputedStyle(header).color,
          bubble: getComputedStyle(header.closest('.bc-message-bubble')!).backgroundColor,
        }));
        const luminance = (rgb: string) => rgb.match(/\d+/g)!.slice(0, 3).map(Number).map(value => {
          const s = value / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const values = [luminance(colors.text), luminance(colors.bubble)].sort((a, b) => a - b);
        expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
      await expect(page.locator('[data-seq="37"]').getByTestId('deleted-placeholder')).toBeAttached();
      await expect(page.locator('[data-seq="37"]').getByTestId('forwarded-header')).toHaveCount(0);
      await expect(page.locator('[data-seq="38"]').getByTestId('forwarded-header')).toContainText(th['message.forwardedUnknown']);
      await expect(page.locator('[data-seq="38"]').getByTestId('forwarded-header')).not.toContainText('null');
      await page.locator('[data-seq="36"] .bc-message-actions-toggle').click();
      await expect(page.getByTestId('message-actions')).toBeVisible();
      await expect(page.getByTestId('edit-button')).toHaveCount(0);
      await expect(page.getByTestId('delete-button')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.locator('[data-seq="35"] .bc-message-actions-toggle').click();
      await expect(page.getByTestId('message-actions')).toBeVisible();
      await expect(page.getByTestId('delete-button')).toHaveCount(0);
      await page.keyboard.press('Escape');
      // Positive control ensures regular own messages retain Edit.
      await page.locator('[data-seq="40"] .bc-message-actions-toggle').click();
      await expect(page.getByTestId('edit-button')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.goto('/rooms/ui-direct');
      const incoming = page.locator('[data-seq="35"] .bc-message-bubble');
      await expect(incoming.getByTestId('forwarded-header')).toHaveText(/ส่งต่อจาก Original Author/);
      await expect(incoming.locator(':scope > p.font-semibold')).toHaveCount(0);
      await expect(page.locator('.bc-chat-header')).toContainText('มินตรา Chen');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });

    test('TC-WEB-079: search targets, exact API-047 body, success and room preview refresh', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      await openChat(page);
      const { dialog, trigger } = await openForward(page);
      await expect(dialog.getByRole('button', { name: 'ส่งต่อ (0)', exact: true })).toBeDisabled();
      const search = dialog.getByRole('searchbox');
      await search.fill('มินตรา');
      await expect(dialog.getByRole('checkbox')).toHaveCount(1);
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
      await search.fill('Design');
      await expect(dialog.getByRole('checkbox')).toHaveCount(1);
      await dialog.getByRole('checkbox', { name: /Design studio/ }).check();
      await search.fill('no-such-room');
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await search.clear();
      await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(2);
      const roomRequests = fixture.roomRequests();
      await dialog.getByRole('button', { name: 'ส่งต่อ (2)', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('status').filter({ hasText: 'ส่งต่อแล้ว 2 ห้อง' })).toBeVisible();
      expect(fixture.forwardRequests).toHaveLength(1);
      expect(fixture.forwardRequests[0]).toEqual({
        client_forward_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        source_room_id: 'ui-design', message_ids: ['ui-message-40'], room_ids: ['ui-direct', 'ui-design'],
      });
      expect(fixture.forwardedCopies.size).toBe(2);
      await expect.poll(() => fixture.roomRequests()).toBeGreaterThan(roomRequests);
      await expect(page.locator('[data-seq="41"]').getByTestId('forwarded-header')).toContainText('Alex Morgan');
      await expect(trigger).toBeFocused();
    });

    test('TC-WEB-079: partial failure marks targets and retry preserves idempotency', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      fixture.failForwardRooms(['ui-direct']);
      await openChat(page);
      const { dialog } = await openForward(page);
      await dialog.getByRole('checkbox', { name: /Design studio/ }).check();
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
      await dialog.getByRole('button', { name: 'ส่งต่อ (2)', exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('ส่งต่อไม่สำเร็จ 1 ห้อง ลองอีกครั้งได้โดยไม่ส่งซ้ำ')).toBeVisible();
      await expect(dialog.getByText('ส่งไม่สำเร็จ', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: /มินตรา Chen/ })).toBeDisabled();
      expect(fixture.forwardRequests).toHaveLength(1);
      expect(fixture.forwardedCopies.size).toBe(1);
      fixture.failForwardRooms([]);
      await dialog.getByRole('button', { name: 'ลองอีกครั้ง', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(fixture.forwardRequests).toHaveLength(2);
      expect(fixture.forwardRequests[1]).toEqual(fixture.forwardRequests[0]);
      expect(fixture.forwardedCopies.size).toBe(2);
      await expect(page.getByRole('status').filter({ hasText: 'ส่งต่อแล้ว 2 ห้อง' })).toBeVisible();
    });

    test('TC-WEB-079: ten-target cap, keyboard selection and Escape restores focus', async ({ page }) => {
      await installChatFixture(page, { forwarding: true });
      await openChat(page);
      const { dialog, trigger } = await openForward(page);
      const checkboxes = dialog.getByRole('checkbox');
      await expect(dialog.getByRole('searchbox')).toBeFocused();
      await expect(checkboxes).toHaveCount(12);
      await page.keyboard.press('Tab');
      await expect(checkboxes.nth(0)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(checkboxes.nth(0)).toBeChecked();
      for (let index = 1; index < 10; index++) await checkboxes.nth(index).check();
      await expect(dialog.getByRole('button', { name: 'ส่งต่อ (10)', exact: true })).toBeEnabled();
      await expect(dialog.getByText('เลือกได้สูงสุด 10 ห้อง', { exact: true })).toBeVisible();
      await expect(checkboxes.nth(10)).toBeDisabled();
      await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(10);
      await checkboxes.nth(0).uncheck();
      await expect(checkboxes.nth(10)).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'ส่งต่อ (9)', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });

    test('TC-WEB-079: close restores focus and reopening creates a new forwarding intent', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      fixture.failForward({ status: 404 });
      await openChat(page);
      for (let attempt = 0; attempt < 2; attempt++) {
        const { dialog, trigger } = await openForward(page);
        await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(0);
        await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
        await dialog.getByRole('button', { name: 'ส่งต่อ (1)', exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText(th['chat.forwardErrorRooms']);
        await dialog.getByRole('button', { name: th['chat.cancel'], exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      expect(fixture.forwardRequests).toHaveLength(2);
      expect(fixture.forwardRequests[1].client_forward_id).not.toBe(fixture.forwardRequests[0].client_forward_id);
    });

    test('TC-WEB-079: busy and lost-response states lock targets for an exact retry', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      fixture.loseForwardResponse(true);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/v1/messages/forward', async route => { await gate; await route.fallback(); });
      await openChat(page);
      const { dialog } = await openForward(page);
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
      await dialog.getByRole('button', { name: 'ส่งต่อ (1)', exact: true }).click();
      try {
        await expect(dialog.getByRole('button', { name: th['chat.sending'], exact: true })).toBeDisabled();
        await expect(dialog.getByRole('checkbox', { name: /มินตรา Chen/ })).toBeDisabled();
        await expect(dialog.getByRole('checkbox', { name: /Design studio/ })).toBeDisabled();
      } finally { release(); }
      await expect(dialog.getByRole('alert')).toHaveText(th['chat.forwardError']);
      await expect(dialog.getByRole('checkbox', { name: /มินตรา Chen/ })).toBeDisabled();
      await expect(dialog.getByRole('checkbox', { name: /Design studio/ })).toBeDisabled();
      expect(fixture.forwardedCopies.size).toBe(1);
      fixture.loseForwardResponse(false);
      await dialog.getByRole('button', { name: th['chat.forwardRetry'], exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(fixture.forwardRequests).toHaveLength(2);
      expect(fixture.forwardRequests[1]).toEqual(fixture.forwardRequests[0]);
      expect(fixture.forwardedCopies.size).toBe(1);
    });

    test('TC-WEB-078: moderator can still delete other members’ forwarded messages', async ({ page }) => {
      await installChatFixture(page, { forwarding: true, roomRole: 'admin' });
      await openChat(page);
      await page.locator('[data-seq="35"] .bc-message-actions-toggle').click();
      await expect(page.getByTestId('message-actions')).toBeVisible();
      await expect(page.getByTestId('edit-button')).toHaveCount(0);
      await page.getByTestId('delete-button').click();
      const deletion = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith('/messages/ui-message-35'));
      await page.getByTestId('message-actions').getByRole('button', { name: th['message.delete'], exact: true }).click();
      await deletion;
      await expect(page.locator('[data-seq="35"]').getByTestId('deleted-placeholder')).toBeVisible();
      await expect(page.locator('[data-seq="35"]').getByTestId('forwarded-header')).toHaveCount(0);
    });

    test('TC-WEB-079: 422 gives a human error and retry preserves request ID', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      fixture.failForward({ status: 422, reason: 'attachment_not_ready' });
      await openChat(page);
      const { dialog } = await openForward(page);
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
      await dialog.getByRole('button', { name: 'ส่งต่อ (1)', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByRole('alert')).not.toContainText('Synthetic forwarding error');
      await expect(dialog.getByRole('alert')).toContainText(/ไฟล์/);
      expect(fixture.forwardedCopies.size).toBe(0);
      fixture.failForward(null);
      await dialog.getByRole('button', { name: /ลองอีกครั้ง|ส่งต่อ \(1\)/ }).click();
      await expect(dialog).toHaveCount(0);
      expect(fixture.forwardRequests[1]).toEqual(fixture.forwardRequests[0]);
    });

    test('TC-WEB-079: F1 HTTP errors unlock targets without changing the request ID', async ({ page }) => {
      const fixture = await installChatFixture(page, { forwarding: true });
      await openChat(page);
      const { dialog } = await openForward(page);
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).check();
      const errors = [
        { status: 404 as const, text: th['chat.forwardErrorRooms'] },
        { status: 403 as const, text: th['chat.forwardErrorMember'] },
        { status: 422 as const, reason: 'message_not_found', text: th['chat.forwardErrorMissing'] },
        { status: 429 as const, text: th['chat.forwardErrorRate'] },
      ];
      for (const error of errors) {
        fixture.failForward(error);
        await dialog.getByRole('button', { name: 'ส่งต่อ (1)', exact: true }).click();
        await expect(dialog.getByRole('alert')).toHaveText(error.text);
        expect(fixture.forwardedCopies.size).toBe(0);
        await expect(dialog.getByRole('checkbox', { name: /มินตรา Chen/ })).toBeEnabled();
        await expect(dialog.getByRole('checkbox', { name: /Design studio/ })).toBeEnabled();
      }
      // A vanished destination can actually be removed, then the same intent
      // can target a different room without losing the idempotency token.
      await dialog.getByRole('checkbox', { name: /มินตรา Chen/ }).uncheck();
      await expect(dialog.getByRole('button', { name: 'ส่งต่อ (0)', exact: true })).toBeDisabled();
      await dialog.getByRole('checkbox', { name: /Design studio/ }).check();
      fixture.failForward(null);
      await dialog.getByRole('button', { name: 'ส่งต่อ (1)', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(fixture.forwardRequests).toHaveLength(5);
      expect(new Set(fixture.forwardRequests.map(input => input.client_forward_id)).size).toBe(1);
      expect(fixture.forwardRequests[4].room_ids).toEqual(['ui-design']);
      expect(fixture.forwardedCopies.size).toBe(1);
    });

    test('TC-WEB-080: unavailable source actions and marked secret targets', async ({ page }) => {
      await installChatFixture(page, { forwarding: true });
      await openChat(page);
      for (const seq of [33, 34, 37]) {
        const row = page.locator(`[data-seq="${seq}"]`);
        await expect(row).toBeAttached();
        await expect(row.locator('.bc-message-actions-toggle')).toHaveCount(0);
      }
      await expect(page.locator('[data-seq="33"] [data-system="true"]')).toBeAttached();
      await expect(page.locator('[data-seq="33"]').getByTestId('forwarded-header')).toHaveCount(0);
      await expect(page.locator('[data-seq="34"] .is-pending')).toBeAttached();
      const { dialog } = await openForward(page);
      await expect(dialog.getByRole('checkbox', { name: /Secret project/ })).toBeEnabled();
      await expect(dialog.getByText('🔒', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/v1/rooms/ui-secret', async route => { await gate; await route.fallback(); });
      await page.goto('/rooms/ui-secret');
      try {
        await expect(page.locator('[data-seq="40"]')).toBeVisible();
        await page.locator('[data-seq="40"] .bc-message-actions-toggle').click();
        await expect(page.getByTestId('message-actions')).toBeVisible();
        await expect(page.getByTestId('message-actions').getByRole('button', { name: 'ส่งต่อ', exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');
      } finally { release(); }
      await expect(page.locator('.bc-chat-header')).toContainText('Secret project');
      await page.locator('[data-seq="40"] .bc-message-actions-toggle').click();
      await expect(page.getByTestId('message-actions')).toBeVisible();
      await expect(page.getByTestId('message-actions').getByRole('button', { name: 'ส่งต่อ', exact: true })).toHaveCount(0);
    });
  });
}
