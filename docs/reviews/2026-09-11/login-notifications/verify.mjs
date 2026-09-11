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
const recipientContext = await browser.newContext({viewport:{width:390,height:844}});
await recipientContext.addInitScript(() => {
  window.soundStarts = 0;
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function(...args) { window.soundStarts++; return start.apply(this,args); };
});
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
  return page.evaluate(async ({ method, args }) => (await import(performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/lib/api.ts')?.name ?? '/src/lib/api.ts')).endpoints[method](...args), { method, args });
}
async function navigate(page, path) {
  await page.bringToFront();
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
  const group = await client(sender, 'createGroup', 'Existing before login', [fixture.receiverId], fixture.slug);
  dmId = group.room.id;
  await login(recipient, fixture.receiver);
  await check('TC-WEB-043-first-login-mobile', async () => {
    await expect(row()).toBeVisible();
    return {roomsVisibleWithoutMenuSwitch:true};
  });
  await recipient.setViewportSize({width:1280,height:900});
  await navigate(sender, `/rooms/${dmId}`);
  await expect(sender.getByTestId('composer-input')).toBeVisible();
  await check('TC-NOTI-025-real-message-sound-title', async () => {
    await send('notification regression');
    await expect.poll(() => recipient.evaluate(() => window.soundStarts)).toBe(1);
    await expect(recipient).toHaveTitle('(2) Banana Chat');
  });
  await check('TC-READ-013-read-clears-title-focused-silent', async () => {
    await navigate(recipient, `/rooms/${dmId}`);
    await recipient.getByTestId('composer-input').click();
    console.log('focus',await recipient.evaluate(()=>({focus:document.hasFocus(),visibility:document.visibilityState})));
    await expect(recipient).toHaveTitle('Banana Chat');
    await send('focused notification regression');
    await expect(recipient.getByText('focused notification regression', {exact:true}).last()).toBeVisible();
    await recipient.waitForTimeout(1800);
    expect(await recipient.evaluate(() => window.soundStarts)).toBe(1);
  });
  await check('TC-NOTI-026-muted-silent', async () => {
    await client(recipient,'roomNotificationSettings',dmId,fixture.slug,{mode:'none'});
    await navigate(recipient,'/');
    await send('muted regression');
    await recipient.waitForTimeout(2500);
    expect(await recipient.evaluate(() => window.soundStarts)).toBe(1);
    await expect(recipient).toHaveTitle('Banana Chat');
    await client(recipient,'roomNotificationSettings',dmId,fixture.slug,{mode:'all'});
  });
  await check('TC-NOTI-025-toggle-persists', async () => {
    await recipient.getByTestId('notification-bell').click();
    await recipient.getByLabel('Notification sound').click();
    await expect(recipient.getByLabel('Notification sound')).not.toBeChecked();
    await expect(recipient.getByLabel('Notification sound')).toBeEnabled();
    await send('sound disabled regression');
    await recipient.waitForTimeout(2500);
    expect(await recipient.evaluate(() => window.soundStarts)).toBe(1);
    await recipient.reload();
    await recipient.getByTestId('notification-bell').click();
    await expect(recipient.getByLabel('Notification sound')).not.toBeChecked();
  });
  await check('TC-WEB-043-room-fetch-recovery', async () => {
    await recipient.route('**/api/v1/rooms?filter=all', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'QA failure'}})}));
    await recipient.reload();
    await expect(recipient.getByRole('alert')).toContainText('Could not load conversations', {timeout:15000});
    await recipient.unroute('**/api/v1/rooms?filter=all');
    await recipient.getByRole('button',{name:'Retry',exact:true}).click();
    await expect(row()).toBeVisible();
    await expect(recipient.getByRole('alert')).toHaveCount(0);
  });
  await check('TC-READ-013-logout-clears-title', async () => {
    await recipient.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(recipient).toHaveURL(/\/login$/);
    await expect(recipient).toHaveTitle('Banana Chat');
  });
  await check('TC-RT-001-no-runtime-errors',async()=>{expect(errors).toEqual([])});
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
