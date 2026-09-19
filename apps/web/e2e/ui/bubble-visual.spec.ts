import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { installChatFixture, message, openChat } from './fixtures';

for (const width of [390, 1440]) {
  test(`TC-UI-MB: compact Thai text and reply bubbles at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await installChatFixture(page);
    const bodies = ['เย็นนี้ทานอะไรกันดี', 'ร้านเดิมไหม อร่อยดีนะ', 'ได้เลย เจอกันหกโมง', 'โอเคครับ 👍', 'จองโต๊ะให้แล้วนะ', 'ขอบคุณมาก 😊', 'แล้วเจอกันนะ', 'ได้เลยครับ'];
    const messages = bodies.map((body, index) => ({ ...message(33 + index, body), reply_to: index === 2 || index === 7 ? { id: 'ui-message-34', seq: 34, sender_id: message(34).sender_id, snippet: 'ร้านเดิมไหม อร่อยดีนะ', deleted: false } : null }));
    await page.route('**/api/v1/rooms/ui-design/messages*', route => route.fulfill({ json: { data: { messages, has_more_before: false, has_more_after: false } } }));
    await openChat(page);
    await page.evaluate(() => document.fonts.ready);
    for (const seq of [35, 40]) {
      const bubble = page.locator(`[data-seq="${seq}"] .bc-message-bubble`);
      const box = await bubble.boundingBox();
      expect(box!.height).toBeLessThan(130);
      const quote = await bubble.locator('.bc-reply-quote').boundingBox();
      expect(quote!.height).toBeGreaterThanOrEqual(44);
      expect(quote!.height).toBeLessThan(70);
    }
    expect((await page.locator('[data-seq="36"] .bc-message-bubble').boundingBox())!.height).toBeLessThan(55);
    const gaps = await page.locator('.bc-message-bubble').evaluateAll(bubbles => bubbles.map(bubble => bubble.getBoundingClientRect().bottom - bubble.querySelector('.bc-message-footer')!.getBoundingClientRect().bottom));
    expect(Math.max(...gaps)).toBeLessThan(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.locator('.bc-chat-header').click();
    await page.screenshot({ path: resolve(testInfo.project.outputDir, '../screenshots', `bubbles-${width}.png`), fullPage: true });
  });
}
