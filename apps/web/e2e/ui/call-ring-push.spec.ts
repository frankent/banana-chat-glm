import { expect, test, type Page } from '@playwright/test';
import type { RoomCall } from '@banana-chat/shared';
import { installChatFixture } from './fixtures';

/**
 * FR-NOTI-010 / DEC-095 — closed-app ringing push for 1-to-1 calls.
 *
 * TC-WEB-CALLPUSH-001 runs the REAL Firebase messaging SDK (loaded from gstatic by
 * public/firebase-messaging-sw.js) inside a real service worker and feeds it the
 * exact web-push payload the API builds (CallPush + FcmPushSender::message, locked
 * by tests/Feature/Call/IncomingCallPushTest.php TC-NOTI-055/062). It asserts what
 * the browser would put on screen: tag, requireInteraction, renotify, vibrate and
 * the tag-replaced missed-call. An OS notification cannot be screenshotted headless;
 * TC-WEB-CALLPUSH-002/003 capture the screen the tap lands on.
 */
const shots = 'e2e-artifacts/ui/screenshots/call-ring-push';

const ring = (callId: string) => ({
  notification: {
    title: 'มินตรา Chen', body: 'สายเรียกเข้า', tag: `call-${callId}`,
    requireInteraction: true, renotify: true, vibrate: [400, 200, 400, 200, 400, 200, 400],
  },
  data: { type: 'call', call_id: callId, room_id: 'ui-direct', workspace_id: 'ui-workspace', kind: 'voice' },
  fcmOptions: { link: 'http://127.0.0.1:5180/rooms/ui-direct' }, from: '123', fcmMessageId: 'ring-1',
});

const missed = (callId: string) => ({
  notification: { title: 'มินตรา Chen', body: 'สายที่ไม่ได้รับ', tag: `call-${callId}`, requireInteraction: false, renotify: false },
  data: { type: 'call_missed', call_id: callId, room_id: 'ui-direct', workspace_id: 'ui-workspace', kind: 'voice' },
  fcmOptions: { link: 'http://127.0.0.1:5180/rooms/ui-direct' }, from: '123', fcmMessageId: 'missed-1',
});

test.describe('FR-NOTI-010 incoming-call push', () => {
  test.use({ permissions: ['notifications'] });

  test('TC-WEB-CALLPUSH-001 the real SDK shows a sticky re-alerting ring that a missed-call replaces (same tag)', async ({ page, context }) => {
    test.skip(!(await fetch('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js', { method: 'HEAD' }).then(r => r.ok, () => false)), 'needs the Firebase CDN');
    await page.route('**/sw-host.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>sw</title>' }));
    await page.goto('/sw-host.html');
    const cfg = 'apiKey=k&projectId=p&messagingSenderId=123&appId=1:123:web:abc';
    await page.evaluate(async (u) => { await navigator.serviceWorker.register(u); await navigator.serviceWorker.ready; }, `/firebase-messaging-sw.js?${cfg}`);
    const worker = context.serviceWorkers().find(w => w.url().includes('firebase-messaging-sw'))!;
    expect(worker).toBeTruthy();
    // The SDK hands the message to a visible window instead of rendering it (the in-app banner
    // covers that case), so close every window first: this is the closed-app path.
    await page.close();

    const push = (p: object) => worker.evaluate((d) => { self.dispatchEvent(new PushEvent('push', { data: d })); }, JSON.stringify(p));
    const shown = () => worker.evaluate(async () => (await self.registration.getNotifications()).map(n => ({
      title: n.title, body: n.body, tag: n.tag, requireInteraction: n.requireInteraction, renotify: n.renotify, vibrate: [...(n.vibrate ?? [])],
      link: (n.data as { FCM_MSG?: { fcmOptions?: { link?: string } } } | null)?.FCM_MSG?.fcmOptions?.link,
    })));

    await push(ring('C1'));
    await expect.poll(shown).toHaveLength(1);
    const [first] = await shown();
    expect(first).toMatchObject({
      title: 'มินตรา Chen', body: 'สายเรียกเข้า', tag: 'call-C1', requireInteraction: true, renotify: true,
      vibrate: [400, 200, 400, 200, 400, 200, 400], link: 'http://127.0.0.1:5180/rooms/ui-direct',
    });

    await push(ring('C1')); // the next 10 s tick: same tag replaces, never stacks
    await push(ring('C1'));
    await page.context().newPage().then(p => p.waitForTimeout(500));
    expect(await shown()).toHaveLength(1);

    await push(missed('C1')); // the call ended unanswered
    await expect.poll(async () => (await shown())[0]?.body).toBe('สายที่ไม่ได้รับ');
    const after = await shown();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tag: 'call-C1', requireInteraction: false, renotify: false });

    await push(ring('C2')); // a different call is its own notification
    await expect.poll(shown).toHaveLength(2);
  });

  const call = (over: Partial<RoomCall> = {}): RoomCall => ({
    id: 'ui-call-1', room_id: 'ui-direct', workspace_id: 'ui-workspace', kind: 'voice', started_by: 'ui-peer', caller_name: 'มินตรา Chen',
    room_name: 'มินตรา Chen', room_type: 'dm', participants: ['ui-peer'], created_at: new Date().toISOString(), connected_at: null, ended_at: null, ...over,
  });

  async function tapThrough(page: Page, c: RoomCall) {
    await installChatFixture(page);
    await page.route('**/api/v1/calls', route => route.fulfill({ json: { data: { enabled: true, calls: [{ ...c, created_at: new Date().toISOString() }] } } }));
    // the notification's fcm_options.link — a tap opens the room, not the app root
    await page.goto('/rooms/ui-direct');
    return page.getByRole('dialog', { name: 'Incoming call' });
  }

  for (const viewport of [{ width: 390, height: 780 }, { width: 1280, height: 800 }]) {
    test(`TC-WEB-CALLPUSH-002 tapping the ring lands in the room with Join/Decline on screen @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const banner = await tapThrough(page, call());
      await expect(banner).toBeVisible();
      await expect(banner.locator('strong')).toContainText('มินตรา Chen');
      await expect(banner.getByRole('button', { name: 'Join' })).toBeVisible();
      await expect(banner.getByRole('button', { name: /Decline/ })).toBeVisible();
      const b = (await banner.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: `${shots}/tap-through-${viewport.width}.png` });
    });
  }

  test('TC-WEB-CALLPUSH-003 tapping a ring that already ended (60 s window passed) shows no ghost banner', async ({ page }) => {
    await installChatFixture(page);
    await page.route('**/api/v1/calls', route => route.fulfill({ json: { data: { enabled: true, calls: [] } } }));
    await page.goto('/rooms/ui-direct');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Incoming call' })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/tap-after-end-390.png` });
  });
});
