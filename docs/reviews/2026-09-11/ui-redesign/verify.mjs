// Local-only live integration: node docs/reviews/2026-09-11/ui-redesign/verify.mjs
// Fresh isolated users/workspace; real UI, API, queue and Reverb; no event mocks.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const root = new URL('../../../../', import.meta.url).pathname;
const run = `dmreview${Date.now()}`;
const negative = process.env.DM_REVIEW_NEGATIVE === '1';
const prefix = negative ? 'negative-' : '';
const results = [], errors = [], events = [];
function php(code) {
  return execFileSync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'exec', '-T', '-e', 'DB_DATABASE=orgchat_review_20260911', 'api', 'php'], {
    cwd: root, input: `<?php require '/app/vendor/autoload.php'; $app=require '/app/bootstrap/app.php'; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); ${code}`,
    encoding: 'utf8',
  });
}
const fixture = JSON.parse(php(`
  $w=App\\Models\\Workspace::factory()->create(['slug'=>'${run}', 'name'=>'DM verification']);
  $s=App\\Models\\User::factory()->create(['username'=>'${run}s','display_name'=>'Review sender']);
  $r=App\\Models\\User::factory()->create(['username'=>'${run}r','display_name'=>'Review receiver']);
  $w->members()->attach($s->id,['role'=>'owner']); $w->members()->attach($r->id,['role'=>'member']);
  echo json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'sender'=>$s->username,'receiver'=>$r->username,'senderId'=>$s->id,'receiverId'=>$r->id]);
`));
const browser = await chromium.launch();
const senderContext = await browser.newContext();
const recipientContext = await browser.newContext();
for (const context of [senderContext, recipientContext]) {
  await context.route(/\/(api|broadcasting)\//, async route => {
    const target = new URL(route.request().url());
    target.host = 'localhost:18000';
    const response = await route.fetch({ url: target.toString() });
    await route.fulfill({ response }).catch(error => {
      if (!/already handled|closed|disposed/.test(error.message)) throw error;
    });
  });
}
const sender = await senderContext.newPage(), recipient = await recipientContext.newPage();
let dmId, waitingId, recipientNavigations = 0, roomRequests = 0;
recipient.on('framenavigated', f => { if (f === recipient.mainFrame()) recipientNavigations++; });
recipient.on('request', r => { if (r.method() === 'GET' && /\/api\/v1\/rooms\?/.test(r.url())) roomRequests++; });
for (const page of [sender, recipient]) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try { const e = JSON.parse(String(frame.payload)); if (e.event && !e.event.startsWith('pusher')) events.push({ receiver: page === recipient, event: e.event }); } catch {}
  }));
}
async function login(page, username) {
  await page.goto('http://localhost:5173/login');
  if (page === sender) await page.screenshot({ path: new URL('login-desktop.png', import.meta.url).pathname });
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('Password123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('aside')).toBeVisible();
  await page.waitForFunction(() => {
    const p = window.Pusher?.instances.at(-1);
    return p?.connection.state === 'connected' && Object.entries(p.channels.channels).some(([name, ch]) => name.startsWith('private-user.') && ch.subscribed);
  });
}
async function client(page, method, ...args) {
  return page.evaluate(async ({ method, args }) => (await import('/src/lib/api.ts')).endpoints[method](...args), { method, args });
}
async function navigate(page, path) {
  await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
}
const row = () => recipient.locator(`aside a[href="/rooms/${dmId}"]`);
const badge = () => row().locator(':scope > span').nth(1);
async function disableAddedListeners() {
  await recipient.evaluate(() => {
    const p = window.Pusher.instances.at(-1);
    const user = Object.entries(p.channels.channels).find(([name]) => name.startsWith('private-user.'))[1];
    for (const event of ['room.created', 'room.activity', 'workspace.unread_changed']) user.unbind(event);
  });
}
async function send(text) {
  const response = sender.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/rooms/${dmId}/messages`));
  await sender.getByTestId('composer-input').fill(text);
  await sender.getByTestId('send-button').click();
  expect((await response).status()).toBe(201);
}
async function check(id, action) {
  if (negative && !['TC-ROOM-006-new-dm', 'TC-READ-011-background-first-message'].includes(id)) return;
  const start = Date.now();
  try { const details = await action(); results.push({ id, passed: true, ms: Date.now() - start, ...details }); }
  catch (e) { results.push({ id, passed: false, ms: Date.now() - start, error: e.message }); }
  console.log(JSON.stringify(results.at(-1)));
  await recipient.screenshot({ path: new URL(`${prefix}${id}.png`, import.meta.url).pathname });
}
try {
  await login(sender, fixture.sender);
  await login(recipient, fixture.receiver);
  await sender.screenshot({ path: new URL('welcome-desktop.png', import.meta.url).pathname });
  const waiting = await client(recipient, 'createGroup', 'Waiting room', [], fixture.slug);
  waitingId = waiting.room.id;
  await navigate(recipient, `/rooms/${waitingId}`);
  await expect(recipient.getByTestId('composer-input')).toBeVisible();
  if (negative) {
    // Counterfactual control: remove ONLY the three added user-channel handlers.
    // Same server, room creation, websocket and UI. No application file changes.
    await disableAddedListeners();
  }
  const initialNavigations = recipientNavigations;
  await check('TC-ROOM-006-new-dm', async () => {
    const before = await client(recipient, 'rooms', fixture.slug);
    expect(before.some(r => r.room.type === 'dm')).toBe(false);
    await sender.getByRole('button', { name: '+ DM', exact: true }).click();
    await sender.getByPlaceholder('Search people…').fill(fixture.receiver);
    const response = sender.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/v1/rooms'));
    await sender.getByRole('button', { name: new RegExp(`@${fixture.receiver}`) }).click();
    const created = await response;
    expect(created.status()).toBe(201);
    dmId = (await created.json()).data.room.id;
    await expect(row()).toBeVisible({ timeout: 10000 });
    expect(recipient.url()).toContain(waitingId);
    expect(recipientNavigations).toBe(initialNavigations);
    return { freshRoom: true, recipientStayedInOtherRoom: true, reloads: 0 };
  });
  if (negative) {
    // Establish a loaded existing room independently of the failed new-DM test.
    await recipient.reload();
    await expect(row()).toBeVisible();
    await recipient.waitForFunction(() => Object.entries(window.Pusher.instances.at(-1).channels.channels).some(([name, ch]) => name.startsWith('private-user.') && ch.subscribed));
    await disableAddedListeners();
  }
  await check('TC-READ-011-background-first-message', async () => {
    await send('DM verification first message');
    await expect(row()).toContainText('DM verification first message', { timeout: 10000 });
    await expect(badge()).toHaveText('1');
    expect(recipient.url()).toContain(waitingId);
    return { previewUpdated: true, unread: 1, reloads: recipientNavigations - initialNavigations };
  });
  await check('TC-READ-011-background-burst', async () => {
    const count = roomRequests;
    for (let i = 1; i <= 5; i++) await send(`DM verification burst ${i}`);
    await expect(row()).toContainText('DM verification burst 5', { timeout: 10000 });
    await expect(badge()).toHaveText('6');
    await recipient.waitForTimeout(2200);
    return { unread: 6, finalPreviewCorrect: true, roomListGetsDuringBurstAndSettle: roomRequests - count };
  });
  await check('TC-READ-003-workspace-badge', async () => {
    const summaries = await client(recipient, 'myWorkspaces');
    const summary = summaries.find(w => w.workspace.slug === fixture.slug);
    const label = await recipient.getByRole('combobox', { name: 'Workspace' }).locator('option:checked').innerText();
    console.log(JSON.stringify({ workspaceProbe: { unreadRooms: summary.unread_rooms_count, totalUnread: summary.total_unread, label } }));
    expect(summary.unread_rooms_count).toBe(1);
    // FR-READ-003 specifies number of unread rooms for the workspace badge.
    await expect(recipient.getByRole('combobox', { name: 'Workspace' }).locator('option:checked')).toContainText('(1)', { timeout: 3000 });
    return { unreadRooms: summary.unread_rooms_count };
  });
  await check('TC-READ-001-open-room-clears-badge', async () => {
    await row().click();
    await expect(recipient.getByTestId('message').filter({ hasText: 'DM verification burst 5' })).toHaveCount(1);
    await expect(row().locator(':scope > span')).toHaveCount(1, { timeout: 10000 });
    const detail = await client(recipient, 'rooms', fixture.slug);
    expect(detail.find(r => r.room.id === dmId).unread_count).toBe(0);
    return { unreadAfterOpen: 0 };
  });
  await check('TC-RT-001-focused-room-message', async () => {
    await send('DM verification focused');
    await expect(recipient.getByTestId('message').filter({ hasText: 'DM verification focused' })).toHaveCount(1, { timeout: 10000 });
    await expect(row().locator(':scope > span')).toHaveCount(1, { timeout: 10000 });
    await expect.poll(async () => (await client(recipient, 'rooms', fixture.slug)).find(r => r.room.id === dmId).unread_count).toBe(0);
    return { liveDelivery: true, unread: 0 };
  });
  await check('TC-MSG-009-reopen-updated-room', async () => {
    await recipient.locator(`aside a[href="/rooms/${waitingId}"]`).click();
    await send('DM verification after leaving');
    await expect(row()).toContainText('DM verification after leaving', { timeout: 10000 });
    await expect(badge()).toHaveText('1');
    await row().click();
    await expect(recipient.getByTestId('message').filter({ hasText: 'DM verification after leaving' })).toHaveCount(1, { timeout: 4000 });
    return { latestMessageVisibleOnReopen: true };
  });
  await check('TC-RT-002-reconnect-catchup', async () => {
    await navigate(recipient, `/rooms/${dmId}`);
    await expect(recipient.getByTestId('composer-input')).toBeVisible();
    await recipient.evaluate(() => window.Pusher.instances.at(-1).disconnect());
    await recipient.waitForFunction(() => window.Pusher.instances.at(-1).connection.state === 'disconnected');
    await send('Missed while disconnected');
    await expect(sender.getByTestId('message').filter({ hasText: 'Missed while disconnected' })).toHaveCount(1);
    await expect(recipient.getByTestId('message').filter({ hasText: 'Missed while disconnected' })).toHaveCount(0);
    await recipient.evaluate(() => window.Pusher.instances.at(-1).connect());
    await expect(recipient.getByTestId('message').filter({ hasText: 'Missed while disconnected' })).toHaveCount(1, { timeout: 15000 });
    return { recoveredMissedMessage: true };
  });
  await check('TC-CORE-030-persisted-failure-retry', async () => {
    const ids = [];
    const pattern = `**/rooms/${dmId}/messages`;
    await sender.route(pattern, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      ids.push(route.request().postDataJSON().client_message_id);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: 'Temporary test failure' } }) });
    });
    await sender.getByTestId('composer-input').fill('Persistent retry verification');
    await sender.getByTestId('send-button').click();
    await expect(sender.getByTestId('outbox-message').filter({ hasText: 'Persistent retry verification' })).toContainText('Temporary test failure', { timeout: 15000 });
    await sender.reload();
    const pending = sender.getByTestId('outbox-message').filter({ hasText: 'Persistent retry verification' });
    await expect(pending).toContainText('Temporary test failure');
    await sender.unroute(pattern);
    const sent = sender.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(`/rooms/${dmId}/messages`));
    await pending.getByRole('button', { name: 'Retry', exact: true }).click();
    ids.push((await sent).postDataJSON().client_message_id);
    await expect(sender.getByTestId('message').filter({ hasText: 'Persistent retry verification' })).toHaveCount(1);
    await expect(pending).toHaveCount(0);
    expect(new Set(ids).size).toBe(1);
    const page = await client(sender, 'messages', dmId, fixture.slug, {});
    expect(page.messages.filter(m => m.body === 'Persistent retry verification')).toHaveLength(1);
    return { attempts: ids.length, stableId: true, persistedAcrossReload: true };
  });
  await check('TC-CORE-023-scroll-search-read-viewport', async () => {
    const room = await client(sender, 'createGroup', 'History viewport verification', [fixture.receiverId], fixture.slug);
    php(`$room=App\\Models\\Room::withoutGlobalScopes()->findOrFail('${room.room.id}');
      for($seq=2;$seq<=81;$seq++) App\\Models\\Message::factory()->create(['room_id'=>$room->id,'workspace_id'=>$room->workspace_id,'sender_id'=>'${fixture.senderId}','seq'=>$seq,'body'=>'History row '.$seq]);
      $room->forceFill(['last_seq'=>81,'last_user_seq'=>81])->save();`);
    await navigate(recipient, `/rooms/${room.room.id}`);
    await expect(recipient.getByTestId('message').filter({ hasText: 'History row 81' })).toBeVisible();
    await expect.poll(async () => (await client(recipient, 'rooms', fixture.slug)).find(r=>r.room.id===room.room.id).unread_count).toBe(0);
    const list=recipient.getByTestId('message-list');
    await list.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
    const anchor=recipient.locator('[data-seq="32"]');
    const y=(await anchor.boundingBox()).y;
    await recipient.getByRole('button',{name:'Load older messages',exact:true}).click();
    await expect(recipient.getByTestId('message').filter({hasText:'History row 2',exact:false}).first()).toBeAttached();
    expect(Math.abs((await anchor.boundingBox()).y-y)).toBeLessThan(55);
    await client(sender,'sendMessage',room.room.id,fixture.slug,'Unread while reading history',crypto.randomUUID());
    await expect.poll(async () => (await client(recipient, 'rooms', fixture.slug)).find(r=>r.room.id===room.room.id).unread_count).toBe(1);
    await recipient.waitForTimeout(1300);
    expect((await client(recipient,'rooms',fixture.slug)).find(r=>r.room.id===room.room.id).unread_count).toBe(1);
    await navigate(recipient, `/rooms/${room.room.id}?around_seq=10`);
    await expect(recipient.locator('[data-seq="10"]')).toBeInViewport();
    await recipient.waitForTimeout(1200);
    expect(recipient.url()).toContain('around_seq=10');
    await expect(recipient.locator('[data-seq="10"]')).toBeInViewport();
    return { prependAnchorPreserved:true, backgroundReadNotSent:true, searchAnchorPreserved:true };
  });
  await check('TC-WEB-UI-existing-edit-delete-controls', async () => {
    await navigate(recipient, `/rooms/${dmId}`);
    await send('UI action verification');
    const bubble = sender.getByTestId('message').filter({ hasText: 'UI action verification' });
    await bubble.hover();
    await bubble.getByTestId('edit-button').click();
    await sender.getByTestId('edit-input').fill('UI edited message');
    await sender.getByTestId('edit-save').click();
    const edited = sender.getByTestId('message').filter({ hasText: 'UI edited message' });
    await expect(recipient.getByTestId('message').filter({ hasText: 'UI edited message' })).toHaveCount(1);
    await edited.hover();
    await edited.getByTestId('delete-button').click();
    await expect(edited).toHaveCount(0);
    await expect(recipient.getByTestId('deleted-placeholder').last()).toBeVisible();
    return { existingEditDeletePreserved: true };
  });
  await check('TC-WEB-UI-responsive-room-navigation', async () => {
    await recipient.setViewportSize({ width: 390, height: 844 });
    await expect(recipient.getByTestId('composer-input')).toBeVisible();
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await recipient.getByRole('button', { name: 'Show conversations', exact: true }).click();
    await expect(recipient.locator('aside')).toBeVisible();
    await recipient.screenshot({ path: new URL('mobile-sidebar.png', import.meta.url).pathname });
    await recipient.locator(`aside a[href="/rooms/${waitingId}"]`).click();
    await expect(recipient.locator('aside')).toBeHidden();
    await expect(recipient.getByTestId('composer-input')).toBeVisible();
    await recipient.screenshot({ path: new URL('mobile-chat.png', import.meta.url).pathname });
    await recipient.getByRole('button', { name: 'Conversations', exact: true }).click();
    await expect(recipient.locator('.bc-sidebar')).toBeVisible();
    await recipient.getByTestId('notification-bell').click();
    const panel = await recipient.getByTestId('notification-panel').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await recipient.getByTestId('notification-bell').click();
    await recipient.locator(`aside a[href="/rooms/${waitingId}"]`).click();
    await expect(recipient.locator('.bc-sidebar')).toBeHidden();
    await recipient.getByTestId('room-media-toggle').click();
    await expect(recipient.getByTestId('room-media-panel')).toBeVisible();
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await recipient.getByRole('button', { name: 'Close media panel' }).click();
    await recipient.setViewportSize({ width: 1280, height: 720 });
    return { mobileNavigation: true, noHorizontalOverflow: true };
  });
  await check('TC-AUTH-013-account-cache-isolation', async () => {
    const privateRoom = await client(sender, 'createGroup', 'Private cache verification', [], fixture.slug);
    await client(sender, 'sendMessage', privateRoom.room.id, fixture.slug, 'PRIVATE CACHE SENTINEL', crypto.randomUUID());
    await navigate(sender, `/rooms/${privateRoom.room.id}`);
    await expect(sender.getByTestId('message').filter({ hasText: 'PRIVATE CACHE SENTINEL' })).toHaveCount(1);
    await sender.evaluate(async () => {
      const { useSession } = await import('/src/state/session.ts');
      await useSession.getState().logout();
    });
    await navigate(sender, '/login');
    // Same document and JS modules, so this catches in-memory QueryClient/store leaks.
    await sender.getByLabel('Username').fill(fixture.receiver);
    await sender.getByLabel('Password').fill('Password123!');
    await sender.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(sender.locator('aside')).toBeVisible();
    await navigate(sender, `/rooms/${privateRoom.room.id}`);
    await expect(sender.getByRole('alert')).toContainText('Unable to open');
    await expect(sender.getByText('PRIVATE CACHE SENTINEL', { exact: true })).toHaveCount(0);
    return { privateDataAbsentAfterAccountSwitch: true };
  });
  await check('TC-RT-001-no-runtime-errors', async () => { expect(errors).toEqual([]); return { errors }; });
} finally {
  for (const page of [sender, recipient]) {
    try { await client(page, 'logout'); } catch {}
  }
  await browser.close();
  // Remove ONLY this run's isolated fixtures. Workspace FK cascades own room/message rows.
  const cleanup = php(`
    Illuminate\\Support\\Facades\\DB::transaction(function () {
      App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${run}')->delete();
      App\\Models\\User::whereIn('id',['${fixture.senderId}','${fixture.receiverId}'])->where('username','like','${run}%')->delete();
    }); echo 'isolated fixture cleanup complete';
  `);
  await writeFile(new URL(`${prefix}results.json`, import.meta.url), JSON.stringify({ negativeControl: negative, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), results, events, errors, cleanup }, null, 2));
  console.log(cleanup);
}
if (results.some(r => !r.passed)) process.exitCode = 1;
