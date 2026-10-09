import { test, expect } from '@playwright/test';
import { installChatFixture, openChat, me, message } from './fixtures';

test('TC-WEB-REACT-001 preset reactions toggle off and replace own emoji', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  const react = target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' });
  await target.hover();
  await react.click();
  await page.keyboard.press('Escape');
  await expect(target.getByRole('button', { name: 'เลือก 👍' })).toHaveCount(0);
  await react.click();
  await target.getByRole('button', { name: 'เลือก 👍' }).click();
  await expect(target.getByRole('button', { name: 'เลือก 👍' })).toHaveCount(0);
  await expect(target.getByTestId('reaction-chip-👍')).toContainText('1');
  await expect(target.getByTestId('reaction-chip-👍')).toHaveAttribute('aria-label', '👍 1 คน — กดเพื่อเอารีแอ็กชันออก, กด Shift+F10 เพื่อดูผู้ที่รีแอ็กชัน');
  await target.hover();
  await target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await target.getByRole('button', { name: 'เลือก ❤️' }).click();
  await expect(target.getByRole('button', { name: 'เลือก ❤️' })).toHaveCount(0);
  await expect(target.getByTestId('reaction-chip-❤️')).toContainText('1');
  await expect(target.getByTestId('reaction-chip-👍')).toHaveCount(0);
  await target.getByTestId('reaction-chip-❤️').click();
  await expect(target.getByTestId('reaction-chip-❤️')).toHaveCount(0);
  expect(fixture.reactionRequests.map(request => request.method)).toEqual(['PUT', 'PUT', 'DELETE']);
});

test('TC-WEB-REACT-002 custom emoji picker supports search, Esc focus return and reactors', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  await target.hover();
  await target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  const plus = target.getByRole('button', { name: 'เลือกอีโมจิ' });
  await plus.click();
  const search = page.getByRole('dialog', { name: 'เลือกอีโมจิ' }).getByLabel('ค้นหาอีโมจิ');
  await search.fill('heart');
  await page.getByRole('button', { name: 'เลือก 💜' }).click();
  await expect(target.getByTestId('reaction-chip-💜')).toBeVisible();
  await expect(target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toBeFocused();
  const chip = target.getByTestId('reaction-chip-💜');
  await chip.click({ button: 'right' });
  const people = page.getByRole('dialog', { name: 'ผู้ที่รีแอ็กชัน' });
  await expect(people).toContainText(me.display_name);
  await expect(people.getByRole('tab', { name: '💜 1 คน' })).toHaveAttribute('aria-selected', 'true');
  await people.getByRole('tab', { name: 'ทั้งหมด' }).click();
  await expect(people.getByRole('tabpanel')).toContainText(me.display_name);
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: [{ emoji: '💜', count: 2 }], actor_id: 'ui-peer', actor_emoji: '💜' });
  await expect(target.getByTestId('reaction-chip-💜')).toContainText('2');
  // Open picker again and verify Escape returns to its trigger.
  await target.hover();
  await target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await target.getByRole('button', { name: 'เลือกอีโมจิ' }).click();
  await page.keyboard.press('Escape');
  await expect(target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toBeFocused();
});

test('TC-WEB-REACT-003 media and deleted messages, responsive overflow, and API rollback', async ({ page }) => {
  const media = { ...message(38), type: 'image' as const, attachments: [{ id: 'ui-image', kind: 'image' as const, status: 'ready' as const, original_name: 'photo.png', mime_type: 'image/png', size_bytes: 100, width: 240, height: 160, duration_ms: null, urls: { thumb_sm: null, thumb_md: 'https://example.test/photo.png', original: 'https://example.test/photo.png', poster: null }, urls_expire_at: new Date(Date.now() + 3600000).toISOString() }] };
  await page.route('**/example.test/photo.png', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
  const fixture = await installChatFixture(page);
  // The harness page message fixture stays deterministic; use an emitted media row to exercise bubble support.
  await openChat(page);
  await fixture.emit('message.created', { message: media });
  const imageBubble = page.locator('[data-seq="38"] [data-testid="message"]');
  await expect(imageBubble.getByTestId('attachment-image')).toBeVisible();
  await imageBubble.hover();
  await imageBubble.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await imageBubble.getByRole('button', { name: 'เลือก 🙏' }).click();
  await expect(imageBubble.getByTestId('reaction-chip-🙏')).toBeVisible();
  const imageBox = await imageBubble.getByTestId('attachment-image').boundingBox();
  const imageChip = await imageBubble.getByTestId('reaction-chip-🙏').locator('.bc-reaction-chip-wrap').boundingBox();
  expect(imageBox).not.toBeNull(); expect(imageChip).not.toBeNull();
  expect(imageChip!.y).toBeGreaterThanOrEqual(imageBox!.y + imageBox!.height);
  await page.setViewportSize({ width: 700, height: 800 });
  await imageBubble.hover();
  const imageTrigger = imageBubble.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' });
  await imageTrigger.click();
  const imagePill = imageBubble.locator('.bc-quick-reactions');
  const imagePillBox = await imagePill.boundingBox();
  const imageBubbleBox = await imageBubble.locator('.bc-message-bubble').boundingBox();
  expect(imagePillBox).not.toBeNull(); expect(imageBubbleBox).not.toBeNull();
  expect(imagePillBox!.y + imagePillBox!.height).toBeLessThanOrEqual(imageBubbleBox!.y - 2);
  await page.keyboard.press('Escape');
  await expect(imageTrigger).toBeFocused();

  const video = { ...message(36), type: 'video' as const, attachments: [{ id: 'ui-video', kind: 'video' as const, status: 'ready' as const, original_name: 'clip.mp4', mime_type: 'video/mp4', size_bytes: 100, width: 240, height: 160, duration_ms: 1000, urls: { thumb_sm: null, thumb_md: null, original: 'https://example.test/clip.mp4', poster: null }, urls_expire_at: new Date(Date.now() + 3600000).toISOString() }] };
  await fixture.emit('message.created', { message: video });
  const videoBubble = page.locator('[data-seq="36"] [data-testid="message"]');
  await expect(videoBubble.getByTestId('attachment-video')).toBeVisible();
  await videoBubble.hover();
  await videoBubble.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await videoBubble.getByRole('button', { name: 'เลือก 😮' }).click();
  const videoBox = await videoBubble.getByTestId('attachment-video').boundingBox();
  const videoChip = await videoBubble.getByTestId('reaction-chip-😮').locator('.bc-reaction-chip-wrap').boundingBox();
  expect(videoBox).not.toBeNull(); expect(videoChip).not.toBeNull();
  expect(videoChip!.y).toBeGreaterThanOrEqual(videoBox!.y + videoBox!.height);

  const twenty = ['😀','😃','😄','😁','😆','😅','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😙','😚','🥲'];
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-38', reactions: twenty.map((emoji, index) => ({ emoji, count: index === 0 ? 1200 : 1 })), actor_id: 'ui-peer', actor_emoji: '😀' });
  await expect(imageBubble.getByTestId(/^reaction-chip-/)).toHaveCount(20);
  await expect(imageBubble.getByTestId('reaction-chip-😀')).toContainText('1.2k');
  await page.setViewportSize({ width: 320, height: 800 });
  const chipPositions = await imageBubble.locator('.bc-reaction-chip-wrap').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y, right: node.getBoundingClientRect().right })));
  expect(new Set(chipPositions.map(position => position.y)).size).toBeGreaterThan(1);
  expect(chipPositions.every(position => position.x >= 0 && position.right <= 320)).toBeTruthy();
  const list = page.getByTestId('message-list');
  await expect(list).toHaveJSProperty('scrollWidth', await list.evaluate(el => el.clientWidth));

  await fixture.emit('message.created', { message: { ...message(37), deleted_at: new Date().toISOString(), body: null } });
  const deleted = page.locator('[data-seq="37"] [data-testid="message"]');
  await expect(deleted.getByTestId(/^reaction-chip-/)).toHaveCount(0);
  await expect(deleted.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toHaveCount(0);
  const system = { ...message(36), id: 'ui-system-message', type: 'system' as const, body: null, system_event: { event: 'room.created' } };
  const optimistic = { ...message(41, 'Optimistic reaction guard'), id: 'optimistic-ui-message' };
  await fixture.emit('message.created', { message: system });
  await fixture.emit('message.created', { message: optimistic });
  await expect(page.locator('[data-testid="message"]').filter({ hasText: 'created the room' }).getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toHaveCount(0);
  await expect(page.locator('[data-testid="message"]').filter({ hasText: 'Optimistic reaction guard' }).getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toHaveCount(0);

  await fixture.failNextReactionLimit();
  // Trigger the next failed PUT through a preset and ensure optimistic UI rolls back.
  await page.setViewportSize({ width: 700, height: 800 });
  await imageBubble.hover();
  await imageBubble.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await imageBubble.getByRole('button', { name: 'เลือก 😂' }).click();
  await expect(imageBubble.getByRole('status')).toContainText('ข้อความนี้มีรีแอ็กชันครบแล้ว');
  // 😂 was already reacted by a peer: rollback restores count 1 and not-pressed, never removes the chip.
  await expect(imageBubble.getByTestId('reaction-chip-😂')).toHaveAttribute('aria-pressed', 'false');
  await expect(imageBubble.getByTestId('reaction-chip-😂')).toContainText('1');

  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(el => el.clientWidth));
  }
});

test('TC-WEB-REACT-004 touch action menu opens quick reactions', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  await expect(target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toBeHidden();
  await expect(target.locator('.bc-quick-reactions')).toHaveCount(0);
  await target.locator('.bc-message-actions-toggle').click();
  const menu = page.getByTestId('message-actions');
  const row = menu.getByRole('group', { name: 'เพิ่มรีแอ็กชัน' });
  await expect(row.locator('button')).toHaveCount(6);
  const menuBox = await menu.boundingBox(); const rowBox = await row.boundingBox();
  expect(menuBox).not.toBeNull(); expect(rowBox).not.toBeNull();
  expect(rowBox!.x).toBeGreaterThanOrEqual(menuBox!.x);
  expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width);
  const touchTargets = await row.locator('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
  expect(touchTargets.every(box => box.width >= 44 && box.height >= 44)).toBeTruthy();
  await expect(menu.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toHaveCount(0);
  await row.getByRole('button', { name: 'เลือก 😂' }).tap();
  await expect(target.getByTestId('reaction-chip-😂')).toBeVisible();
  const chip = await target.getByTestId('reaction-chip-😂').locator('.bc-reaction-chip-wrap').boundingBox();
  expect(chip).not.toBeNull();
  expect(chip!.height).toBeLessThanOrEqual(36);

  await target.locator('.bc-message-actions-toggle').tap();
  await page.getByTestId('message-actions').getByRole('button', { name: 'ผู้ที่รีแอ็กชัน' }).tap();
  const reactors = page.getByRole('dialog', { name: 'ผู้ที่รีแอ็กชัน' });
  await expect(reactors).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(target.locator('.bc-message-actions-toggle')).toBeFocused();
  const touchChip = target.getByTestId('reaction-chip-😂');
  const touchChipBox = await touchChip.boundingBox();
  expect(touchChipBox).not.toBeNull();
  await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)!;
    const touch = new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
    element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
  }, { x: touchChipBox!.x + touchChipBox!.width / 2, y: touchChipBox!.y + touchChipBox!.height / 2 });
  const longPressDialog = page.getByRole('dialog', { name: 'ผู้ที่รีแอ็กชัน' });
  await expect(longPressDialog).toBeVisible();
  await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)!;
    element.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [new Touch({ identifier: 1, target: element, clientX: x, clientY: y })] }));
  }, { x: touchChipBox!.x + touchChipBox!.width / 2, y: touchChipBox!.y + touchChipBox!.height / 2 });
  await page.keyboard.press('Escape');
  await expect(touchChip).toBeFocused();
  await context.close();
});

test('TC-WEB-REACT-005 desktop hover pill and chips stay anchored and compact', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  const wrappedEmojis = ['😀','😃','😄','😁','😆','😅','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😙','😚','🥲'];
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: wrappedEmojis.map(emoji => ({ emoji, count: 1 })), actor_id: 'ui-peer', actor_emoji: '😀' });
  await page.setViewportSize({ width: 320, height: 800 });
  const initialRows = await target.locator('.bc-reaction-chip-wrap').evaluateAll(nodes => [...new Set(nodes.map(node => node.getBoundingClientRect().y))].sort((a, b) => a - b));
  expect(initialRows.length).toBeGreaterThan(1);
  expect(Math.max(...initialRows.slice(1).map((row, index) => row - initialRows[index]!))).toBeLessThanOrEqual(32);
  for (const width of [700, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await target.hover();
    const triggerLocator = target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' });
    await triggerLocator.click();
    const pill = target.locator('.bc-quick-reactions');
    await expect(pill).toBeVisible();
    const pillBox = await pill.boundingBox();
    expect(pillBox).not.toBeNull();
    expect(pillBox!.x).toBeGreaterThanOrEqual(0);
    expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(width);
    if (width === 700) {
      const bubble = await target.locator('.bc-message-bubble').boundingBox();
      const trigger = await triggerLocator.boundingBox();
      const actions = await target.locator('.bc-message-actions-toggle').boundingBox();
      const next = await page.locator('[data-seq="40"] .bc-message-bubble').boundingBox();
      expect(bubble).not.toBeNull(); expect(trigger).not.toBeNull(); expect(actions).not.toBeNull(); expect(next).not.toBeNull();
      if (await pill.getAttribute('class').then(value => value?.includes('is-below'))) expect(pillBox!.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height + 2);
      else expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(bubble!.y - 2);
      const overlaps = (a: NonNullable<typeof trigger>, b: NonNullable<typeof actions>) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      expect(overlaps(trigger!, actions!)).toBeFalsy();
      expect(overlaps(trigger!, next!)).toBeFalsy();
    }
    const ys = await pill.locator('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().y));
    expect(ys).toHaveLength(6);
    expect(new Set(ys).size).toBe(1);
    const presetSizes = await pill.locator('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
    expect(presetSizes.every(box => box.width >= 36 && box.width <= 40 && box.height >= 36 && box.height <= 40)).toBeTruthy();
    if (width === 1440) {
      const trigger = await triggerLocator.boundingBox();
      const text = await target.locator('.bc-markdown').boundingBox();
      expect(trigger).not.toBeNull();
      expect(text).not.toBeNull();
      expect(trigger!.x + trigger!.width <= text!.x || text!.x + text!.width <= trigger!.x || trigger!.y + trigger!.height <= text!.y || text!.y + text!.height <= trigger!.y).toBeTruthy();
    }
    await pill.getByRole('button', { name: 'เลือก 👍' }).click();
    await expect(pill).toHaveCount(0);
    const chip = await target.getByTestId('reaction-chip-👍').locator('.bc-reaction-chip-wrap').boundingBox();
    expect(chip).not.toBeNull();
    expect(chip!.height).toBe(28);
    const chipButton = await target.getByTestId('reaction-chip-👍').boundingBox();
    const hitArea = await target.getByTestId('reaction-chip-👍').evaluate(node => getComputedStyle(node, '::after').top);
    expect(chipButton).not.toBeNull();
    expect(chipButton!.width).toBeGreaterThanOrEqual(44);
    expect(chipButton!.height).toBe(28);
    expect(hitArea).toBe('-8px');
    await target.getByTestId('reaction-chip-👍').click();
    await expect(target.getByTestId('reaction-chip-👍')).toHaveCount(0);
  }
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', await page.locator('body').evaluate(el => el.clientWidth));
});

test('TC-WEB-REACT-006 fine pointer narrow desktop actions menu exposes quick reactions', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: false, isMobile: false });
  const page = await context.newPage();
  const fixture = await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  await target.hover();
  await expect(target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' })).toHaveCount(0);
  await target.locator('.bc-message-actions-toggle').click();
  const menu = page.getByTestId('message-actions');
  const row = menu.getByRole('group', { name: 'เพิ่มรีแอ็กชัน' });
  await expect(row).toBeVisible();
  const rowButtonSizes = await row.locator('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
  expect(rowButtonSizes.every(box => box.width >= 36 && box.width <= 40 && box.height >= 36 && box.height <= 40)).toBeTruthy();
  await row.getByRole('button', { name: 'เลือก 😂' }).click();
  await expect(target.getByTestId('reaction-chip-😂')).toBeVisible();
  expect(fixture.reactionRequests.filter(request => request.method === 'PUT' && request.emoji === '😂')).toHaveLength(1);
  await expect(menu).toHaveCount(0);
  await context.close();
});

test('TC-WEB-REACT-007 withheld reaction event refetches counts once', async ({ page }) => {
  const fixture = await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  fixture.holdReactionPut();
  await target.hover();
  await target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await target.getByRole('button', { name: 'เลือก 🙏' }).click();
  await expect.poll(() => fixture.reactionRequests.filter(request => request.method === 'PUT').length).toBe(1);
  fixture.setReactionCountOverride('ui-message-39', [{ emoji: '👍', count: 9 }, { emoji: '🔥', count: 4 }]);
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: [{ emoji: '👍', count: 3 }, { emoji: '🔥', count: 1 }], actor_id: 'ui-peer', actor_emoji: '🔥' });
  fixture.releaseReactionPut();
  await expect(target.getByTestId('reaction-chip-👍')).toContainText('9');
  await expect(target.getByTestId('reaction-chip-🔥')).toContainText('4');
  await expect.poll(() => fixture.reactionRequests.filter(request => request.method === 'GET' && request.messageId === 'ui-message-39').length).toBe(1);
});

test('TC-WEB-REACT-008 keyboard-only reaction, toggle and reactors tabs', async ({ page }) => {
  const fixture = await installChatFixture(page);
  fixture.seedReaction('ui-message-39', '🔥');
  await openChat(page);
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: [{ emoji: '🔥', count: 1 }], actor_id: 'ui-peer', actor_emoji: '🔥' });
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  const pressTabUntilFocused = async (selector: string, max = 120) => {
    const element = page.locator(selector);
    for (let index = 0; index < max; index++) {
      if (await element.evaluate(node => node === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error(`Keyboard focus did not reach ${selector}`);
  };
  await pressTabUntilFocused('[data-seq="39"] .bc-reaction-open');
  await page.keyboard.press('Enter');
  await pressTabUntilFocused('[data-seq="39"] .bc-quick-reactions button[aria-label="เลือก 👍"]');
  await page.keyboard.press('Enter');
  const ownChip = target.getByTestId('reaction-chip-👍');
  await expect(ownChip).toBeVisible();
  await pressTabUntilFocused('[data-seq="39"] [data-testid="reaction-chip-👍"]');
  await page.keyboard.press('Enter');
  await expect(ownChip).toHaveCount(0);
  await pressTabUntilFocused('[data-seq="39"] .bc-message-actions-toggle');
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('message-actions');
  await pressTabUntilFocused('[data-testid="message-actions"] button[aria-label="ผู้ที่รีแอ็กชัน"]');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'ผู้ที่รีแอ็กชัน' });
  await expect(dialog).toBeVisible();
  const allTab = dialog.getByRole('tab', { name: 'ทั้งหมด' });
  await expect(allTab).toHaveAttribute('aria-selected', 'true');
  const panel = dialog.getByRole('tabpanel');
  await page.keyboard.press('Shift+Tab');
  await expect(panel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'ปิด' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(allTab).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const fireTab = dialog.getByRole('tab', { name: '🔥 1 คน' });
  await expect(fireTab).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(target.locator('.bc-message-actions-toggle')).toBeFocused();
  expect(fixture.reactionRequests.filter(request => request.method === 'PUT').map(request => request.emoji)).toEqual(['👍']);
  void menu;
});

test('TC-WEB-REACT-009 English reaction labels pluralize counts', async ({ page }) => {
  const fixture = await installChatFixture(page, { locale: 'en' });
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: [{ emoji: '👍', count: 1 }], actor_id: 'ui-peer', actor_emoji: '👍' });
  const chip = target.getByTestId('reaction-chip-👍');
  await expect(chip).toHaveAttribute('aria-label', '👍 1 reaction — press to react, press Shift+F10 to see who reacted');
  await fixture.emit('message.reactions_changed', { room_id: 'ui-design', message_id: 'ui-message-39', reactions: [{ emoji: '👍', count: 2 }], actor_id: 'ui-peer', actor_emoji: '👍' });
  await expect(chip).toHaveAttribute('aria-label', '👍 2 reactions — press to react, press Shift+F10 to see who reacted');
});

test('TC-WEB-REACT-010 picker accepts a pasted flag, keycap or skin-tone emoji and Thai keywords find emoji', async ({ page }) => {
  await installChatFixture(page);
  await openChat(page);
  const target = page.locator('[data-seq="39"] [data-testid="message"]');
  await target.hover();
  await target.getByRole('button', { name: 'เพิ่มรีแอ็กชัน' }).click();
  await target.getByRole('button', { name: 'เลือกอีโมจิ' }).click();
  const picker = page.getByRole('dialog', { name: 'เลือกอีโมจิ' });
  const search = picker.getByLabel('ค้นหาอีโมจิ');
  await search.fill('หัวใจ');
  await expect(picker.getByRole('button', { name: 'เลือก 💜' })).toBeVisible();
  for (const emoji of ['🇹🇭', '1️⃣', '👍🏽', `${'👨\u200D'.repeat(15)}👨`]) {
    await search.fill(emoji);
    await expect(picker.getByRole('button', { name: `เลือก ${emoji}` })).toHaveCount(1);
  }
  await search.fill('1');
  await expect(picker.getByRole('button', { name: 'เลือก 1️⃣' })).toHaveCount(0);
  await search.fill('🇹🇭');
  await search.press('Enter');
  await expect(target.getByTestId('reaction-chip-🇹🇭')).toBeVisible();
});
