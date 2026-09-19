import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { installChatFixture, me, message, openChat } from './fixtures';

for (const width of [320, 390, 1440]) {
  test(`TC-UI-001/012: ${width}px conversation reflows without horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await installChatFixture(page);
    await openChat(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-seq="40"] .bc-markdown p').first()).toHaveCSS('font-size', width < 768 ? '16px' : '15px');
    // FR-UI-MB: assert actual geometry, not only ownership classes or colour.
    const ownRow = page.locator('[data-seq="40"] .bc-message');
    const otherRow = page.locator('[data-seq="39"] .bc-message');
    await expect(ownRow).toHaveAttribute('data-mine', 'true');
    await expect(otherRow).toHaveAttribute('data-mine', 'false');
    const alignment = await page.locator('.bc-message[data-mine]').evaluateAll(rows => rows.map(row => {
      const box = row.getBoundingClientRect();
      const bubble = row.querySelector('.bc-message-bubble')!.getBoundingClientRect();
      return { mine: row.getAttribute('data-mine') === 'true', left: bubble.left - box.left, right: box.right - bubble.right };
    }));
    for (const row of alignment) {
      if (row.mine) {
        expect(row.right).toBeLessThanOrEqual(2);
        expect(row.left).toBeGreaterThan(row.right);
      } else {
        expect(row.left).toBeLessThanOrEqual(width < 768 ? 2 : 40);
        expect(row.right).toBeGreaterThan(row.left);
      }
    }
    const header = await page.locator('.bc-chat-header').boundingBox();
    expect(header!.height).toBeLessThanOrEqual(80);
    const title = await page.locator('.bc-chat-identity h2').boundingBox();
    const headerLayout = await page.locator('.bc-chat-header').evaluate(el => [...el.querySelectorAll('*')].slice(0, 15).map(node => ({ tag: node.tagName, class: node.getAttribute('class'), width: node.getBoundingClientRect().width, flex: getComputedStyle(node).flex, minWidth: getComputedStyle(node).minWidth })));
    expect(title!.width, JSON.stringify(headerLayout)).toBeGreaterThan(80);
    await expect(page.locator('.bc-room-tools > summary')).toBeInViewport();
    if (width < 768) {
      await expect(page.locator('.bc-rail')).not.toBeVisible();
      const chat = await page.locator('.bc-chat').boundingBox();
      expect(chat!.width).toBeGreaterThanOrEqual(width - 2);
    }
    await page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots', `conversation-${width}.png`), fullPage: true });
  });
}

test('TC-UI-005: closed touch message actions consume no layout space', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await installChatFixture(page);
  await openChat(page);
  const heights = await page.getByTestId('message-actions').evaluateAll(elements => elements.filter(el => el.getAttribute('data-open') !== 'true').map(el => el.getBoundingClientRect().height));
  expect(Math.max(0, ...heights)).toBe(0);
  await expect(page.locator('.bc-message-actions-toggle').last()).toBeVisible();
  await context.close();
});

test('TC-UI-005: Escape closes message actions and returns keyboard focus', async ({ page }) => {
  await installChatFixture(page);
  await openChat(page);
  const toggle = page.locator('[data-seq="40"] .bc-message-actions-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('TC-UI-007: quote destination is visibly highlighted and clears after live update', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const destination = page.locator('[data-seq="34"]');
  const paint = () => destination.evaluate(el => [el, el.querySelector('.bc-message-bubble')!].map(node => { const style = getComputedStyle(node); return [style.backgroundColor, style.boxShadow, style.outlineWidth, style.animationName]; }));
  const initialPaint = await paint();
  await page.locator('[data-seq="39"] .bc-reply-quote').click();
  await expect(destination).toHaveAttribute('data-highlight', 'true');
  await expect.poll(paint).not.toEqual(initialPaint);
  await fixture.emit('message.updated', { message: { ...message(34), body: 'Updated while the quote is highlighted', edit_count: 1, edited_at: new Date().toISOString() } });
  await expect(destination).toContainText('Updated while');
  await expect(destination).not.toHaveAttribute('data-highlight', 'true', { timeout: 3500 });
  // The second jump uses the already-resolved around_seq React Query cache.
  await page.getByTestId('jump-to-latest').click();
  await page.locator('[data-seq="39"] .bc-reply-quote').click();
  await expect(destination).toHaveAttribute('data-highlight', 'true');
  await expect.poll(paint).not.toEqual(initialPaint);
  await expect(destination).not.toHaveAttribute('data-highlight', 'true', { timeout: 3500 });
});

test('TC-UI-003: a failed room refresh retains already loaded conversations', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const rows = page.locator('.bc-room-row[href]');
  await expect(rows).toHaveCount(3);
  fixture.failRooms();
  await fixture.emit('room.created', {}, 'private-user.ui-me');
  await expect(page.locator('.bc-sidebar [role="alert"]')).toBeVisible({ timeout: 12000 });
  await expect(rows).toHaveCount(3);
});

test('TC-UI-008: incoming messages preserve reader viewport and offer jump to latest', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const list = page.getByTestId('message-list');
  await list.evaluate(el => { el.scrollTop -= 500; });
  const before = await list.evaluate(el => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  await fixture.emit('message.created', { message: message(41, 'A new message while you read history') });
  await expect(page.locator('[data-seq="41"]')).toHaveCount(1);
  expect(Math.abs(await list.evaluate(el => el.scrollTop) - before)).toBeLessThanOrEqual(4);
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  // Wait beyond the receipt throttle to prove history arrivals are not read.
  await page.waitForTimeout(1200);
  expect(fixture.reads.some(read => read.seq === 41)).toBe(false);
  await page.getByTestId('jump-to-latest').click();
  await expect.poll(() => fixture.reads.some(read => read.seq === 41)).toBe(true);
  await expect.poll(() => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
});

test('TC-UI-009: prepend concurrent with incoming preserves anchor and loads once', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const list = page.getByTestId('message-list');
  await list.evaluate(el => { el.scrollTop = 220; });
  const anchor = await list.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('[data-seq]')].find(node => node.getBoundingClientRect().bottom > top)!;
    return { seq: row.dataset.seq, offset: row.getBoundingClientRect().top - top };
  });
  expect(Number(anchor.seq)).toBeGreaterThan(21);
  fixture.holdOlder();
  // Two immediate activations exercise single-flight before disabled state paints.
  await page.getByTestId('history-load-more').evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
  await expect.poll(() => fixture.olderRequests()).toBe(1);
  await fixture.emit('message.created', { message: message(41, 'Arrived while loading history') });
  await expect(page.locator('[data-seq="41"]')).toHaveCount(1);
  fixture.releaseOlder();
  await expect(page.locator('[data-seq="1"]')).toHaveCount(1);
  const offset = await page.locator(`[data-seq="${anchor.seq}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('[data-testid="message-list"]')!.getBoundingClientRect().top);
  expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(4);
});

test('TC-UI-009: height-changing realtime edit above viewport preserves reader anchor', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const list = page.getByTestId('message-list');
  await list.evaluate(el => { el.scrollTop = 600; });
  const anchor = await list.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('[data-seq]')].find(node => node.getBoundingClientRect().bottom > top)!;
    return { seq: row.dataset.seq, offset: row.getBoundingClientRect().top - top };
  });
  expect(Number(anchor.seq)).toBeGreaterThan(21);
  await fixture.emit('message.updated', { message: { ...message(21), body: 'Edited earlier message\n'.repeat(12), edited_at: new Date().toISOString(), edit_count: 1 } });
  await expect(page.locator('[data-seq="21"]')).toContainText('Edited earlier message');
  const offset = await page.locator(`[data-seq="${anchor.seq}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('[data-testid="message-list"]')!.getBoundingClientRect().top);
  expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(4);
});

test('TC-UI-002: mobile Back retains conversation filter and list reflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installChatFixture(page);
  await page.goto('/');
  const unread = page.locator('.bc-room-filters button').last();
  await unread.click();
  await expect(page.locator('.bc-room-row[href]')).toHaveCount(2);
  await page.locator('.bc-room-row[href="/rooms/ui-design"]').click();
  await expect(page.locator('[data-seq="40"]')).toBeVisible();
  await page.getByRole('button', { name: /Back to conversations|กลับไปรายการแชท/ }).click();
  await expect(unread).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.bc-room-row[href]')).toHaveCount(2);
  await expect(page.locator('.bc-sidebar')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots/conversation-list-mobile.png'), fullPage: true });
});

test('TC-UI-002/009: switching rooms restores each room reader position', async ({ page }) => {
  await installChatFixture(page);
  await openChat(page);
  const list = page.getByTestId('message-list');
  await list.evaluate(el => { el.scrollTop = 500; });
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  const anchor = await list.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('[data-seq]')].find(node => node.getBoundingClientRect().bottom > top + 1)!;
    return { seq: row.dataset.seq, offset: row.getBoundingClientRect().top - top };
  });
  expect(Number(anchor.seq)).toBeGreaterThan(21);
  await page.locator('.bc-room-row[href="/rooms/ui-direct"]').click();
  await expect(page.locator('.bc-chat-identity h2')).toHaveText('มินตรา Chen');
  await expect.poll(() => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
  await page.locator('.bc-room-row[href="/rooms/ui-design"]').click();
  await expect(page.locator('.bc-chat-identity h2')).toHaveText('Design studio · ออกแบบ');
  const offset = await page.locator(`[data-seq="${anchor.seq}"]`).evaluate(el => el.getBoundingClientRect().top - el.closest('[data-testid="message-list"]')!.getBoundingClientRect().top);
  expect(Math.abs(offset - anchor.offset)).toBeLessThanOrEqual(4);
});

test('TC-UI-009: stale history response cannot remove another room pagination', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  fixture.holdOlder();
  await page.getByTestId('history-load-more').evaluate((el: HTMLButtonElement) => el.click());
  await expect.poll(() => fixture.olderRequests()).toBe(1);
  await page.locator('.bc-room-row[href="/rooms/ui-direct"]').click();
  await expect(page.locator('.bc-chat-identity h2')).toHaveText('มินตรา Chen');
  await expect(page.getByTestId('history-load-more')).toBeEnabled();
  const oldResponse = page.waitForResponse(response => response.url().includes('/rooms/ui-design/messages?before_seq='));
  fixture.releaseOlder();
  await oldResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByTestId('history-load-more')).toBeEnabled();
  await expect(page.locator('[data-seq="1"]')).toHaveCount(0);
});

test('TC-UI-007: reply return restores exact reader offset', async ({ page }) => {
  await installChatFixture(page);
  await openChat(page);
  const list = page.getByTestId('message-list');
  const anchor = await list.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('[data-seq]')].find(node => node.getBoundingClientRect().bottom > top)!;
    return { seq: row.dataset.seq, offset: row.getBoundingClientRect().top - top };
  });
  await page.locator('[data-seq="39"] .bc-reply-quote').click();
  await expect(page).toHaveURL(/around_seq=34/);
  await page.getByRole('button', { name: /Back to where you were|กลับจุดที่อ่าน/ }).click();
  await expect.poll(() => page.locator(`[data-seq="${anchor.seq}"]`).evaluate((el, original) => Math.abs(el.getBoundingClientRect().top - el.closest('[data-testid="message-list"]')!.getBoundingClientRect().top - original), anchor.offset)).toBeLessThanOrEqual(4);
});

test('TC-UI-008/010: sending from an anchor returns to latest and exits anchor mode', async ({ page }) => {
  await installChatFixture(page);
  await openChat(page);
  await page.locator('[data-seq="39"] .bc-reply-quote').click();
  await expect(page).toHaveURL(/around_seq=34/);
  const composer = page.locator('.bc-composer textarea');
  await composer.fill('A synthetic message from anchored history');
  await composer.press('Enter');
  await expect(page).not.toHaveURL(/around_seq/);
  await expect(page.locator('[data-seq="41"]')).toContainText('A synthetic message from anchored history');
  await expect.poll(() => page.getByTestId('message-list').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(4);
});

test('TC-UI-008: new-message count excludes duplicates edits and own messages', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  await page.getByTestId('message-list').evaluate(el => { el.scrollTop -= 500; });
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  const badge = page.getByTestId('jump-to-latest').locator('span');
  await fixture.emit('message.created', { message: message(41, 'First new message') });
  await expect(badge).toHaveText(/^1 /);
  await fixture.emit('message.created', { message: message(41, 'First new message') });
  await fixture.emit('message.updated', { message: { ...message(41, 'Edited incoming message'), edit_count: 1, edited_at: new Date().toISOString() } });
  await expect(page.locator('[data-seq="41"]')).toContainText('Edited incoming message');
  await expect(badge).toHaveText(/^1 /);
  await fixture.emit('message.created', { message: { ...message(42, 'My message from another session'), sender_id: me.id, sender: me } });
  await expect(page.locator('[data-seq="42"]')).toHaveCount(1);
  await expect(badge).toHaveText(/^1 /);
  await fixture.emit('message.created', { message: message(43, 'Second incoming message') });
  await expect(badge).toHaveText(/^2 /);
});

test('TC-UI-007/FR-RT-003: typing subscription survives quote navigation and return to latest', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const indicator = page.getByTestId('typing-indicator');
  const typing = { user_id: 'ui-peer', display_name: 'มินตรา Chen', typing: true };
  await fixture.emit('room.typing', typing);
  await expect(indicator).toContainText(typing.display_name);
  await fixture.emit('room.typing', { ...typing, typing: false });
  await expect(indicator).not.toContainText(typing.display_name);
  await page.locator('[data-seq="39"] .bc-reply-quote').click();
  await expect(page).toHaveURL(/around_seq=34/);
  await page.getByTestId('jump-to-latest').click();
  await expect(page).not.toHaveURL(/around_seq/);
  await fixture.emit('room.typing', typing);
  await expect(indicator).toContainText(typing.display_name);
  await fixture.emit('room.typing', { ...typing, typing: false });
  await expect(indicator).not.toContainText(typing.display_name);
});
