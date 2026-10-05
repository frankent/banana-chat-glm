import { expect, test, type Page } from '@playwright/test';

/**
 * FR-CALL-008/009 / DEC-094 — remote call audio plays through the boost graph
 * while the AudioContext runs, and through the (otherwise muted) <audio>
 * elements whenever it does not (backgrounded phone, locked autoplay).
 *
 * Real WebRTC/SFU audio is not available here, so the production
 * useCallPlaybackFallback hook runs against a real AudioContext and a real
 * RemoteAudioTrack in e2e/ui/harness/call-audio.html. Whether a physical
 * phone keeps the element alive in the background is device-only (OQ-018).
 */
type Snapshot = { contextState: string; elements: Array<{ muted: boolean; volume: number }> };
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { __audioHarness: { state(): Snapshot } }).__audioHarness.state());
const ctx = (page: Page, action: 'suspend' | 'resume') =>
  page.evaluate((a) => (window as unknown as { __audioHarness: { context: AudioContext } }).__audioHarness.context[a](), action);

async function openHarness(page: Page) {
  await page.goto('/e2e/ui/harness/call-audio.html');
  await page.evaluate(async () => {
    const h = (window as unknown as { __audioHarness: { context: AudioContext; attach(): void } }).__audioHarness;
    await h.context.resume();
    h.attach();
  });
  await expect.poll(async () => (await snapshot(page)).contextState).toBe('running');
}

test.describe('FR-CALL-008/009 playback hand-off', () => {
  test('TC-CALL-050 a running context keeps the elements muted (graph plays, no double audio)', async ({ page }) => {
    await openHarness(page);
    expect((await snapshot(page)).elements).toEqual([{ muted: true, volume: 0 }]);
    await page.waitForTimeout(1500); // longer than the safety sync: still muted
    expect((await snapshot(page)).elements[0]!.muted).toBe(true);
  });

  test('TC-CALL-050 a suspended/interrupted context un-mutes the element at full volume; a running one re-mutes it', async ({ page }) => {
    await openHarness(page);

    await ctx(page, 'suspend');
    await expect.poll(async () => (await snapshot(page)).elements[0]).toEqual({ muted: false, volume: 1 });

    await ctx(page, 'resume');
    await expect.poll(async () => (await snapshot(page)).elements[0]!.muted).toBe(true);
  });

  test('TC-CALL-050 an element attached while the context is suspended is un-muted too (late attach)', async ({ page }) => {
    await openHarness(page);
    await ctx(page, 'suspend');
    await expect.poll(async () => (await snapshot(page)).contextState).toBe('suspended');
    // livekit mutes it on attach and tries context.resume(); block that so no state-change event
    // fires and only the periodic sync can notice the late element (RoomAudioRenderer attaches
    // after TrackSubscribed, when no element exists yet).
    await page.evaluate(() => {
      const h = (window as unknown as { __audioHarness: { context: AudioContext; attach(): void; detachAll(): void } }).__audioHarness;
      h.detachAll(); // livekit only mutes the FIRST attached element of a track
      const resume = h.context.resume.bind(h.context);
      h.context.resume = () => new Promise(() => {});
      h.attach();
      h.context.resume = resume;
    });
    await expect.poll(async () => (await snapshot(page)).contextState).toBe('suspended');
    await expect.poll(async () => (await snapshot(page)).elements.map(e => e.muted)).toEqual([false]);
  });

  test('TC-CALL-050 unmounting stops the sync: a later suspend leaves the element untouched', async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => (window as unknown as { __audioHarness: { unmount(): Promise<void> } }).__audioHarness.unmount());
    await ctx(page, 'suspend');
    await page.waitForTimeout(1500);
    expect((await snapshot(page)).elements[0]!.muted).toBe(true);
  });
});
