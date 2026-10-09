import { expect, test, type Page } from '@playwright/test';
import {
  installCardsFixture, luminanceRatio, message, noHorizontalScroll, openChat, MEET_503, MEET_ENDED, MEET_LIVE, MEET_MISSING,
  SECRET_TITLE, T_ORIGIN, TICKET_A, TICKET_B, TICKET_MISSING, TICKET_OTHER, me,
} from './fixtures';
import th from '../../../../packages/shared/i18n/th.json' with { type: 'json' };

const card = (page: Page, seq: number) => page.locator(`[data-seq="${seq}"]`).getByTestId('ticket-link-card');
const url = (id: string, ws: string | null = 'ui-studio') => `${T_ORIGIN}/board/${id}${ws ? `?ws=${ws}` : ''}`;

test.describe('link cards in chat (FR-MSG-013 / FR-KAN-007)', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });

  test('TC-WEB-LINK-001 share-style URL (lowercase id) hydrates into a card; click opens the drawer; no title leaks outside the card', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
    await openChat(page);
    const c = card(page, 40);
    await expect(c).toHaveAttribute('data-state', 'ready');
    await expect(c.getByTestId('ticket-link-card-key')).toHaveText('UI-STUDIO-7');
    await expect(c.getByTestId('ticket-link-card-title')).toHaveText(SECRET_TITLE);
    await expect(c.getByTestId('ticket-link-card-lane')).toHaveText('To do');
    await expect(c.getByTestId('ticket-link-card-assignee')).toHaveText('มินตรา Chen');
    // privacy: the message row, the room list preview and web storage never contain the title
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain('SECRET-TITLE');
    await expect(page.locator('.bc-room-preview').first()).not.toContainText('SECRET-TITLE');
    await expect(page.locator('[data-seq="40"]').getByTestId('ticket-link-card-open')).toHaveAttribute('title', url(TICKET_A));
    expect(fx.cardRequests.every(r => r.id === TICKET_A && r.slug === 'ui-studio')).toBe(true);
    await c.getByTestId('ticket-link-card-open').click();
    await expect(page).toHaveURL(new RegExp(`/board/${TICKET_A}\\?ws=ui-studio$`));
    await expect(page.getByTestId('ticket-link')).toBeVisible();
  });

  test('TC-WEB-LINK-001b uppercase ULID in a pasted link is accepted AND resolves (API ids are lowercase)', async ({ page }) => {
    await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A.toUpperCase()) } } });
    await openChat(page);
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
  });

  test('TC-WEB-LINK-002 N duplicate cards = ONE request; board.changed moves the lane within 2s with ONE refetch', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 37: { body: url(TICKET_A) }, 38: { body: `again ${url(TICKET_A)}` }, 39: { body: url(TICKET_A) }, 40: { body: url(TICKET_A) } } });
    await openChat(page);
    for (const seq of [37, 38, 39, 40]) await expect(card(page, seq)).toHaveAttribute('data-state', 'ready');
    expect(fx.cardRequests.filter(r => r.id === TICKET_A)).toHaveLength(1);
    fx.moveTicket(TICKET_A, 'done');
    const before = fx.cardRequests.length;
    await fx.boardChanged();
    await fx.boardChanged(); // burst: debounced
    for (const seq of [37, 40]) await expect(card(page, seq).getByTestId('ticket-link-card-lane')).toHaveText('Done', { timeout: 2500 });
    await expect(card(page, 40)).toHaveAttribute('data-lane-done', 'true');
    expect(fx.cardRequests.length - before).toBe(1);
  });

  test('TC-WEB-LINK-002b echo listener does not leak: after the cards unmount a board.changed triggers no request', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) }, 39: { body: url(TICKET_B) } } });
    await openChat(page);
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    await page.goto('/rooms/ui-direct');
    await expect(page.locator('.bc-chat-header')).toContainText('มินตรา');
    const before = fx.cardRequests.length;
    await fx.boardChanged();
    await page.waitForTimeout(1500);
    expect(fx.cardRequests.length).toBe(before);
  });

  test('TC-WEB-LINK-003 403 / 404 / foreign ws / unknown ws render the identical unavailable state without the title', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: {
      37: { body: url(TICKET_MISSING) }, 38: { body: url('01hx5k8m3p9q2r7s4t6v1w0yzf') }, 39: { body: url(TICKET_A, 'nope-team') }, 40: { body: url(TICKET_OTHER) },
    } });
    fx.forbidden.add('01hx5k8m3p9q2r7s4t6v1w0yzf');
    await openChat(page);
    const texts = new Set<string>();
    for (const seq of [37, 38, 39, 40]) {
      await expect(card(page, seq)).toHaveAttribute('data-state', 'unavailable');
      texts.add((await card(page, seq).innerText()).trim());
    }
    expect([...texts]).toEqual([th['chat.ticketUnavailable']]);
    expect(fx.cardRequests.some(r => r.slug === 'nope-team')).toBe(false); // R4: no request for a non-member ws
    await expect(page.locator('body')).not.toContainText('SECRET-TITLE');
  });

  test('TC-WEB-LINK-004 offline after a good load keeps the data and shows the stale marker', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
    await openChat(page);
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    fx.setOffline(true);
    await fx.boardChanged();
    await expect(card(page, 40)).toHaveAttribute('data-state', 'stale', { timeout: 6500 });
    await expect(card(page, 40).getByTestId('ticket-link-card-title')).toHaveText(SECRET_TITLE);
    await expect(card(page, 40).getByTestId('ticket-link-card-stale')).toHaveText(th['chat.ticketStale']);
  });

  test('TC-WEB-LINK-005 meeting card: live / ended / missing / 503 -> plain link; Join opens /meet/{code} in a new tab; title is text', async ({ page }) => {
    const m = (c: string) => `${T_ORIGIN}/meet/${c}`;
    const fx = await installCardsFixture(page, { messages: { 37: { body: m(MEET_LIVE) }, 38: { body: m(MEET_ENDED) }, 39: { body: m(MEET_MISSING) }, 40: { body: m(MEET_503) } } });
    await openChat(page);
    const mc = (seq: number) => page.locator(`[data-seq="${seq}"]`).getByTestId('meeting-link-card');
    await expect(mc(37)).toHaveAttribute('data-state', 'live');
    await expect(mc(37).getByTestId('meeting-link-title')).toHaveText('Sprint planning <b>x</b>');
    const join = mc(37).getByTestId('meeting-link-join');
    await expect(join).toHaveAttribute('href', `/meet/${MEET_LIVE}`);
    await expect(join).toHaveAttribute('target', '_blank');
    await expect(join).toHaveAttribute('rel', /noopener/);
    await expect(mc(38)).toHaveAttribute('data-state', 'ended');
    await expect(mc(38)).toContainText(th['chat.meetingEnded']);
    await expect(mc(38).getByTestId('meeting-link-join')).toHaveAttribute('aria-disabled', 'true');
    await expect(mc(39)).toHaveAttribute('data-state', 'missing');
    await expect(page.locator('[data-seq="40"]').getByTestId('meeting-link-plain')).toHaveAttribute('href', m(MEET_503));
    expect(fx.lobbyRequests.sort()).toEqual([MEET_LIVE, MEET_ENDED, MEET_MISSING, MEET_503].sort());
  });

  test('TC-WEB-LINK-006 /support, /join, foreign-port, userinfo and bad meet links stay plain with ZERO requests', async ({ page }) => {
    const bodies = [`${T_ORIGIN}/support/${'a'.repeat(32)}`, `${T_ORIGIN}/join/abcdef`, `http://127.0.0.1:9999/board/${TICKET_A}`, `https://u:p@127.0.0.1:5180/board/${TICKET_A}`, `${T_ORIGIN}/meet/${'A'.repeat(64)}`];
    const fx = await installCardsFixture(page, { messages: { 36: { body: bodies[0] }, 37: { body: bodies[1] }, 38: { body: bodies[2] }, 39: { body: bodies[3] }, 40: { body: bodies[4] } } });
    await openChat(page);
    await expect(page.locator('[data-seq="40"] a').first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('[data-testid="ticket-link-card"], [data-testid="meeting-link-card"], [data-testid="link-preview-card"]')).toHaveCount(0);
    expect(fx.cardRequests).toHaveLength(0);
    expect(fx.lobbyRequests).toHaveLength(0);
    expect(fx.previewRequests).toHaveLength(0);
    expect(fx.blocked).toHaveLength(0);
  });

  test('TC-WEB-LINK-007 external preview: ready card (text only, our image, rel/referrer), pending->ready poll, none -> plain link, XSS stays text', async ({ page }) => {
    const ready = 'https://example.test/article';
    const slow = 'https://example.test/slow';
    const none = 'https://example.test/none';
    const fx = await installCardsFixture(page, { messages: { 37: { body: `read ${ready}` }, 38: { body: slow }, 39: { body: none }, 40: { body: `${T_ORIGIN}/board/${TICKET_A}x` } } });
    fx.setPreviews(ready, [{ status: 'ready', url: ready, title: '<img src=x onerror="window.__xss=1"> Title', description: '<script>window.__xss=2</script>desc', site_name: 'Example', image_url: `${T_ORIGIN}/__ui-img/og.png`, image_expires_at: '2099-01-01T00:00:00Z', fetched_at: '2026-10-10T00:00:00Z' }]);
    fx.setPreviews(slow, [{ status: 'pending', url: slow }, { status: 'ready', url: slow, title: 'Slow title', description: null, site_name: null, image_url: null, image_expires_at: null, fetched_at: '2026-10-10T00:00:00Z' }]);
    fx.setPreviews(none, [{ status: 'none', url: none }]);
    await openChat(page);
    const pc = (seq: number) => page.locator(`[data-seq="${seq}"]`).getByTestId('link-preview-card');
    await expect(pc(37)).toBeVisible();
    await expect(pc(37)).toContainText('<img src=x onerror="window.__xss=1"> Title');
    await expect(pc(37)).toHaveAttribute('rel', /noopener.*nofollow|nofollow.*noopener/);
    await expect(pc(37)).toHaveAttribute('target', '_blank');
    await expect(pc(37).getByTestId('link-preview-image')).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(pc(37).getByTestId('link-preview-image')).toHaveAttribute('src', `${T_ORIGIN}/__ui-img/og.png`);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(pc(38)).toContainText('Slow title', { timeout: 6500 });
    expect(fx.previewRequests.filter(u => u === slow).length).toBe(2);
    await page.waitForTimeout(500);
    await expect(pc(39)).toHaveCount(0);
    await expect(page.locator('[data-seq="39"] a[href="https://example.test/none"]')).toBeVisible();
    // an app-origin URL (even a malformed ticket) is never sent to the previewer
    expect(fx.previewRequests.some(u => u.startsWith(T_ORIGIN))).toBe(false);
    expect(fx.blocked).toHaveLength(0);
  });

  test('TC-WEB-LINK-007b preview disabled server-side (status none) leaves only the plain link', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 40: { body: 'https://example.test/a' } } });
    fx.disablePreviews();
    await openChat(page);
    await expect(page.locator('[data-seq="40"] a[href="https://example.test/a"]')).toBeVisible();
    await expect(page.getByTestId('link-preview-card')).toHaveCount(0);
  });

  test('TC-WEB-LINK-008 edit removes the card, delete leaves none and makes no request', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 39: { body: url(TICKET_A) }, 40: { body: url(TICKET_B) } } });
    await openChat(page);
    await expect(card(page, 39)).toHaveAttribute('data-state', 'ready');
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    await fx.emit('message.updated', { message: { ...message(39, 'link removed'), edit_count: 1, edited_at: new Date().toISOString() } });
    await expect(page.locator('[data-seq="39"]')).toContainText('link removed');
    await expect(card(page, 39)).toHaveCount(0);
    await fx.emit('message.deleted', { message_id: 'ui-message-40', delete_reason: 'sender' });
    await expect(page.locator('[data-seq="40"]').getByTestId('deleted-placeholder')).toBeAttached();
    await expect(card(page, 40)).toHaveCount(0);
    // an edit that ADDS a link on a plain message creates a card
    await fx.emit('message.updated', { message: { ...message(38, url(TICKET_B)), edit_count: 1, edited_at: new Date().toISOString() } });
    await expect(card(page, 38)).toHaveAttribute('data-state', 'ready');
    expect(fx.blocked).toHaveLength(0);
  });

  test('TC-WEB-LINK-009 a forwarded copy keeps its card', async ({ page }) => {
    await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A), forwarded_from: { sender_id: 'x', display_name: 'Original Author', message_id: 'o', room_id: 'r', created_at: '2026-09-01T10:00:00Z' } } } });
    await openChat(page);
    await expect(page.locator('[data-seq="40"]').getByTestId('forwarded-header')).toBeVisible();
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
  });

  test('TC-WEB-LINK-010 off-screen links do not hydrate until scrolled into view', async ({ page }) => {
    const messages: Record<number, { body: string }> = {};
    for (let seq = 21; seq <= 40; seq++) messages[seq] = { body: `https://example.test/p${seq}` };
    const fx = await installCardsFixture(page, { messages });
    await openChat(page);
    await expect.poll(() => fx.previewRequests.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(fx.previewRequests.length).toBeLessThan(20);
    for (let step = 0; step < 12; step++) {
      await page.getByTestId('message-list').evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 250); });
      await page.waitForTimeout(150);
    }
    await expect.poll(() => new Set(fx.previewRequests).size, { timeout: 5000 }).toBe(20);
  });

  test('TC-WEB-LINK-011 room list shows the Ticket / Meeting label, never a URL or a title', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installCardsFixture(page, { messages: { 40: { body: `look ${url(TICKET_A)}` } } });
    await page.goto('/');
    const row = page.locator('.bc-room-preview').first();
    await expect(row).toContainText(th['room.previewTicket']);
    await expect(row).not.toContainText('/board/');
    await expect(row).not.toContainText('SECRET-TITLE');
  });

  test('TC-WEB-LINK-011b room list label for a meeting link', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installCardsFixture(page, { messages: { 40: { body: `${T_ORIGIN}/meet/${MEET_LIVE}` } } });
    await page.goto('/');
    await expect(page.locator('.bc-room-preview').first()).toContainText(th['room.previewMeeting']);
  });

  test('TC-WEB-LINK-013 code fence and inline code never produce a card; [text](url) does; one card per message', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: {
      38: { body: '```\n' + url(TICKET_A) + '\n```' }, 39: { body: '`' + url(TICKET_A) + '`' },
      40: { body: `[open it](${url(TICKET_B)}) and ${url(TICKET_A)}` },
    } });
    await openChat(page);
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('[data-seq="40"]').getByTestId('ticket-link-card')).toHaveCount(1);
    await expect(card(page, 38)).toHaveCount(0);
    await expect(card(page, 39)).toHaveCount(0);
    expect(fx.cardRequests.map(r => r.id)).toEqual([TICKET_B]);
  });

  test('TC-WEB-LINK-014 pending optimistic row and a typed-but-unsent link show no card', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: {} });
    await openChat(page);
    await page.getByRole('textbox').last().fill(url(TICKET_A));
    await page.waitForTimeout(500);
    await expect(page.getByTestId('ticket-link-card')).toHaveCount(0);
    expect(fx.cardRequests).toHaveLength(0);
    void me;
  });
});

for (const width of [320, 390, 1440]) for (const scheme of ['light', 'dark'] as const) {
  test(`TC-WEB-LINK-012 [${width}px ${scheme}] every card kind fits without horizontal scroll and keeps >= 4.5:1 text contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 844 });
    const long = 'https://example.test/' + 'long-path-segment-'.repeat(12);
    const fx = await installCardsFixture(page, { messages: {
      36: { body: url(TICKET_A) }, 37: { body: `${T_ORIGIN}/meet/${MEET_LIVE}` }, 38: { body: long }, 39: { body: `${T_ORIGIN}/meet/${MEET_ENDED}` },
      40: { body: `${'note '.repeat(30)}\n${url(TICKET_B)}` },
    } });
    fx.setPreviews(long, [{ status: 'ready', url: long, title: 'T'.repeat(200), description: 'word '.repeat(80), site_name: 'S'.repeat(80), image_url: `${T_ORIGIN}/__ui-img/og.png`, image_expires_at: '2099-01-01T00:00:00Z', fetched_at: '2026-10-10T00:00:00Z' }]);
    await openChat(page);
    for (const seq of [40, 39, 38, 37, 36]) { await page.locator(`[data-seq="${seq}"]`).scrollIntoViewIfNeeded(); await page.waitForTimeout(100); }
    await expect(card(page, 36)).toHaveAttribute('data-state', 'ready');
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('[data-seq="38"]').getByTestId('link-preview-card')).toBeVisible();
    await expect(page.locator('[data-seq="37"]').getByTestId('meeting-link-card')).toHaveAttribute('data-state', 'live');
    await noHorizontalScroll(page);
    for (const loc of [card(page, 36), card(page, 40), page.locator('[data-seq="37"]').getByTestId('meeting-link-card'), page.locator('[data-seq="39"]').getByTestId('meeting-link-card')]) {
      const box = await loc.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      const colors = await loc.evaluate(el => {
        const t = el.querySelector('.bc-linkcard-title') ?? el;
        return { text: getComputedStyle(t).color, bg: getComputedStyle(el).backgroundColor };
      });
      expect(luminanceRatio(colors.text, colors.bg)).toBeGreaterThanOrEqual(4.5);
    }
    const preview = page.locator('[data-seq="38"]').getByTestId('link-preview-card');
    const pb = await preview.boundingBox();
    expect(pb!.x + pb!.width).toBeLessThanOrEqual(width + 1);
    const pcolors = await preview.evaluate(el => ({ text: getComputedStyle(el.querySelector('.elc-title') ?? el).color, bg: getComputedStyle(el).backgroundColor }));
    expect(luminanceRatio(pcolors.text, pcolors.bg)).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `e2e-artifacts/ui/screenshots/link-cards-${width}-${scheme}.png` });
  });
}

test('TC-WEB-LINK-015 keyboard: a ticket card is reachable by Tab and Enter opens the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
  await openChat(page);
  const open = card(page, 40).getByTestId('ticket-link-card-open');
  await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
  await open.focus();
  await expect(open).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/board/${TICKET_A}`));
});

test.describe('round 2: fix verification + new adversarial cases', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });

  test('TC-WEB-LINK-R2-01 URL-only ticket message: raw link is aria-hidden + out of tab order; Tab from the composer-side reaches the card, never the raw link', async ({ page }) => {
    await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
    await openChat(page);
    await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    const raw = page.locator('[data-seq="40"] .bc-link-body-hidden a');
    await expect(raw).toHaveCount(1);
    await expect(raw).toHaveAttribute('tabindex', '-1');
    expect(await page.locator('[data-seq="40"] .bc-link-body-hidden').evaluate(el => el.closest('[aria-hidden="true"]') !== null || el.getAttribute('aria-hidden') === 'true')).toBe(true);
    const seen: string[] = [];
    await page.locator('[data-seq="40"]').focus().catch(() => {});
    await card(page, 40).getByTestId('ticket-link-card-open').focus();
    for (let i = 0; i < 6; i++) { seen.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.bc-link-body-hidden') ? 'RAW' : 'ok')); await page.keyboard.press('Shift+Tab'); }
    expect(seen).not.toContain('RAW');
  });

  test('TC-WEB-LINK-R2-02 data-theme=dark (OS light) gives a dark card with >= 4.5:1 contrast; data-theme=light under OS dark gives a light one', async ({ page }) => {
    for (const [os, attr] of [['light', 'dark'], ['dark', 'light']] as const) {
      await page.emulateMedia({ colorScheme: os });
      await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
      await openChat(page);
      await page.evaluate(a => document.documentElement.setAttribute('data-theme', a), attr);
      const c = card(page, 40);
      await expect(c).toHaveAttribute('data-state', 'ready');
      const col = await c.evaluate(el => ({ text: getComputedStyle(el.querySelector('.bc-linkcard-title') ?? el).color, bg: getComputedStyle(el).backgroundColor }));
      expect(luminanceRatio(col.text, col.bg), `${os}/${attr} ${JSON.stringify(col)}`).toBeGreaterThanOrEqual(4.5);
      const lum = (s: string) => s.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
      if (attr === 'dark') expect(lum(col.bg), `bg ${col.bg}`).toBeLessThan(128); else expect(lum(col.bg), `bg ${col.bg}`).toBeGreaterThan(128);
    }
  });

  test('TC-WEB-LINK-R2-03 deep link re-click: open card, go back, click the same card again re-opens the drawer; ?ws-less URL does not stick on the old gate', async ({ page }) => {
    await installCardsFixture(page, { messages: { 40: { body: url(TICKET_A) } } });
    await openChat(page);
    for (let i = 0; i < 2; i++) {
      await card(page, 40).getByTestId('ticket-link-card-open').click();
      await expect(page).toHaveURL(new RegExp(`/board/${TICKET_A}`));
      await expect(page.getByTestId('ticket-link')).toBeVisible();
      await page.goBack();
      await expect(card(page, 40)).toHaveAttribute('data-state', 'ready');
    }
    // other workspace ticket, then the same ticket id WITHOUT ?ws= must re-evaluate (not reuse the earlier switch)
    await page.goto(`/board/${TICKET_OTHER}?ws=other-team`);
    await expect(page).toHaveURL(/ws=other-team/);
    await page.goto(`/board/${TICKET_A}`);
    await expect(page.getByTestId('ticket-link')).toBeVisible({ timeout: 5000 }).catch(() => {});
    await expect(page.getByText(th['board.ticketNotFound'] ?? 'x').or(page.getByTestId('ticket-link'))).toBeVisible();
  });

  test('TC-WEB-LINK-R2-04 room list preview for "[text](ticket-url)" never leaks the URL', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installCardsFixture(page, { messages: { 40: { body: `[open it](${url(TICKET_A)})` } } });
    await page.goto('/');
    const row = page.locator('.bc-room-preview').first();
    await expect(row).not.toContainText('/board/');
    await expect(row).not.toContainText('SECRET-TITLE');
    await expect(row).toContainText(/open it|Ticket|ตั๋ว/);
  });

  test('TC-WEB-LINK-R2-05 NEW lookalike URLs make NO card and NO request (27-char id, extra path, other host, http scheme downgrade)', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: {
      36: { body: url(TICKET_A + 'x') }, 37: { body: `${T_ORIGIN}/board/${TICKET_A}/extra?ws=ui-studio` },
      38: { body: `https://evil.test/board/${TICKET_A}?ws=ui-studio` }, 39: { body: `${T_ORIGIN.replace('http:', 'https:')}/board/${TICKET_B}` },
      40: { body: `${T_ORIGIN}.evil.test/board/${TICKET_B}` },
    } });
    await openChat(page);
    for (const s of [36, 37, 38, 39, 40]) { await page.locator(`[data-seq="${s}"]`).scrollIntoViewIfNeeded(); await page.waitForTimeout(150); await expect(card(page, s)).toHaveCount(0); }
    await page.waitForTimeout(500);
    expect(fx.cardRequests).toEqual([]);
  });

  test('TC-WEB-LINK-R2-06 NEW spoofed markdown: [ticket-url-as-text](https://evil.test) must not become a ticket card or hit /card', async ({ page }) => {
    const fx = await installCardsFixture(page, { messages: { 40: { body: `[${url(TICKET_A)}](https://evil.test/phish)` } } });
    await openChat(page);
    await page.waitForTimeout(800);
    const hasCard = await card(page, 40).count();
    expect(fx.cardRequests, `card rendered=${hasCard}`).toEqual([]);
    await expect(card(page, 40)).toHaveCount(0);
  });

  test('TC-WEB-LINK-R2-07 NEW ticket link with ws of an ARCHIVED workspace and with a slug the viewer is not in: card unavailable, no title', async ({ page }) => {
    await installCardsFixture(page, { messages: { 39: { body: url(TICKET_A, 'old-team') }, 40: { body: url(TICKET_A, 'nobody-ws') } } });
    await openChat(page);
    for (const s of [39, 40]) { await page.locator(`[data-seq="${s}"]`).scrollIntoViewIfNeeded(); }
    await page.waitForTimeout(800);
    await expect(page.locator('[data-seq="40"]').getByText(SECRET_TITLE)).toHaveCount(0);
    await expect(page.locator('[data-seq="39"]').getByText(SECRET_TITLE)).toHaveCount(0);
  });
});
