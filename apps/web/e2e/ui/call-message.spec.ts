import { expect, test, type Page } from '@playwright/test';
import type { Message, RoomCall } from '@banana-chat/shared';
import { installChatFixture, me, message } from './fixtures';

/**
 * FR-CALL-010 / DEC-091 — "call started" system message with a Join button.
 * API is synthetic (page.route); the card's live/ended state comes from the
 * mocked GET /calls, exactly as in production.
 */
const shots = '/tmp/claude-1000/-home-frankent-trycatch/09812a92-422e-4ecf-8bb4-0a81594aa308/scratchpad/call-message-shots';
const peer = { id: 'ui-peer', username: 'ui-peer', display_name: 'มินตรา Chen', avatar_attachment_id: null };

const callMessage = (kind: 'video' | 'voice' = 'video'): Message => ({
  ...message(41), id: 'ui-call-msg', type: 'system', body: null, sender_id: peer.id, sender: peer,
  system_event: { event: 'call_started', call_id: 'ui-call-1', kind },
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
});

const liveCall = (over: Partial<RoomCall> = {}): RoomCall => ({
  id: 'ui-call-1', room_id: 'ui-design', workspace_id: 'ui-workspace', kind: 'video', started_by: peer.id, caller_name: peer.display_name,
  room_name: 'Design studio · ออกแบบ', room_type: 'group', participants: [peer.id, 'ui-other'],
  // older than the 60 s ring window: the late-joiner case, no incoming banner
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(), connected_at: null, ended_at: null, ...over,
});

async function setup(page: Page, opts: { calls: RoomCall[]; kind?: 'video' | 'voice'; enabled?: boolean; locale?: 'en' }) {
  await installChatFixture(page);
  const state = { calls: opts.calls, joins: [] as string[] };
  await page.route(/\/api\/v1\/rooms\/ui-design\/messages(\?.*)?$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    if (url.searchParams.get('before') || url.searchParams.get('after_seq') || url.searchParams.get('after')) return route.fulfill({ json: { data: { messages: [], has_more_before: false, has_more_after: false } } });
    const messages = [...Array.from({ length: 20 }, (_, i) => message(i + 21)), callMessage(opts.kind)];
    return route.fulfill({ json: { data: { messages, has_more_before: false, has_more_after: false } } });
  });
  await page.route('**/api/v1/calls', route => route.fulfill({ json: { data: { enabled: opts.enabled ?? true, calls: state.calls } } }));
  await page.route('**/api/v1/calls/*/join', route => {
    state.joins.push(route.request().url().split('/').at(-2)!);
    return route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: 'Synthetic: stop before media' } } });
  });
  if (opts.locale === 'en') {
    await page.route('**/api/v1/me', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { data: { user: { ...me, locale: 'en', is_system_admin: false }, settings: { locale: 'en', timezone: 'Asia/Bangkok', notification: null } } } })
      : route.fallback());
  }
  await page.goto('/rooms/ui-design');
  return state;
}

const card = (page: Page) => page.getByTestId('call-started-card');

test.describe('FR-CALL-010 call started message', () => {
  test('TC-WEB-CALLMSG-001 live call: who started it, how many are in, and a Join button that joins THIS call', async ({ page }) => {
    const state = await setup(page, { calls: [liveCall()] });
    await expect(card(page)).toHaveAttribute('data-state', 'live');
    await expect(card(page)).toContainText('มินตรา Chen เริ่มวิดีโอคอล');
    await expect(card(page)).toContainText('กำลังคุย · 2 คนในสาย');
    await expect(page.getByRole('dialog', { name: 'Incoming call' })).toHaveCount(0);
    await card(page).getByRole('button', { name: 'เข้าร่วมสาย' }).click();
    await expect.poll(() => state.joins).toEqual(['ui-call-1']);
  });

  test('TC-WEB-CALLMSG-002 ended call: "call ended", no Join; voice wording + phone icon', async ({ page }) => {
    await setup(page, { calls: [], kind: 'voice' });
    await expect(card(page)).toHaveAttribute('data-state', 'ended');
    await expect(card(page)).toContainText('มินตรา Chen เริ่มโทรด้วยเสียง');
    await expect(card(page)).toContainText('สายจบแล้ว');
    await expect(card(page).getByRole('button')).toHaveCount(0);
  });

  test('TC-WEB-CALLMSG-003 the card flips from live to ended on its own (no reload)', async ({ page }) => {
    const state = await setup(page, { calls: [liveCall()] });
    await expect(card(page).getByTestId('call-started-join')).toBeVisible();
    state.calls = [];
    await expect(card(page)).toHaveAttribute('data-state', 'ended', { timeout: 12_000 });
    await expect(card(page).getByTestId('call-started-join')).toHaveCount(0);
  });

  test('TC-WEB-CALLMSG-004 a different call in the same room never lights up an old card', async ({ page }) => {
    await setup(page, { calls: [liveCall({ id: 'ui-call-2' })] });
    await expect(card(page)).toHaveAttribute('data-state', 'ended');
  });

  test('TC-WEB-CALLMSG-005 keyboard: Join is reachable and fires with Enter', async ({ page }) => {
    const state = await setup(page, { calls: [liveCall()] });
    const join = card(page).getByTestId('call-started-join');
    await join.focus();
    await expect(join).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => state.joins).toEqual(['ui-call-1']);
  });

  test('TC-WEB-CALLMSG-006 English copy; calls disabled shows the line without a button', async ({ page }) => {
    await setup(page, { calls: [liveCall()], locale: 'en', enabled: false });
    await expect(card(page)).toContainText('มินตรา Chen started a video call');
    await expect(card(page).getByRole('button')).toHaveCount(0);
  });

  for (const viewport of [{ width: 360, height: 760 }, { width: 1280, height: 800 }]) {
    test(`TC-WEB-CALLMSG-007 card layout fits @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await setup(page, { calls: [liveCall()] });
      const box = (await card(page).boundingBox())!;
      const join = (await card(page).getByTestId('call-started-join').boundingBox())!;
      const icon = (await card(page).locator('.bc-call-msg-icon').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(join.x + join.width).toBeLessThanOrEqual(box.x + box.width);
      expect(join.height).toBeGreaterThanOrEqual(32);
      expect(Math.abs(icon.width - icon.height)).toBeLessThanOrEqual(1);
      expect(join.y).toBeGreaterThanOrEqual(box.y);
      expect(join.y + join.height).toBeLessThanOrEqual(box.y + box.height);
      await card(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/live-${viewport.width}.png` });
    });
  }
});
