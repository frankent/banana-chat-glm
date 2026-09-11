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
  return execFileSync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'exec', '-T', '-e', 'DB_DATABASE=orgchat_kanban_review', 'api', 'php'], {
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
const recipientContext = await browser.newContext({viewport:{width:1440,height:1000}});
await recipientContext.addInitScript(() => {
  window.soundStarts = 0;
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function(...args) { window.soundStarts++; return start.apply(this,args); };
});
for (const context of [senderContext, recipientContext]) {
  await context.route(/\/(api|broadcasting)\//, async route => {
    const target = new URL(route.request().url());
    target.host = 'localhost:18000';
    let response;
    try { response = await route.fetch({ url: target.toString(), timeout:60000 }); } catch (e) { if (/closed|disposed/.test(e.message)) return; throw e; }
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
  page.setDefaultTimeout(45000);
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
  await expect(page.locator('aside')).toBeVisible({timeout:45000});
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
  await login(sender,fixture.sender); await login(recipient,fixture.receiver);
  await navigate(sender,'/board'); await navigate(recipient,'/board');
  let ticket;
  await check('TC-KAN-008-create-and-live-share', async()=>{
    await sender.getByRole('button',{name:'+ Create ticket',exact:true}).click();
    await sender.getByLabel('Title',{exact:true}).fill('Ship workspace kanban');
    await sender.getByLabel('Description',{exact:true}).fill('**Acceptance**: every member can collaborate.');
    await sender.getByLabel('Type',{exact:true}).selectOption('story');
    await sender.getByLabel('Priority',{exact:true}).selectOption('high');
    await sender.getByLabel('Assignee',{exact:true}).selectOption(fixture.receiverId);
    await sender.getByLabel('Labels',{exact:true}).fill('release, product');
    await sender.getByRole('button',{name:'Save ticket',exact:true}).click();
    await expect(sender.getByRole('dialog',{name:'Ticket details'})).toBeVisible();
    ticket=(await client(sender,'boardTickets',fixture.slug)).tickets[0];
    await expect(recipient.getByRole('heading',{name:'Ship workspace kanban',exact:true})).toBeVisible({timeout:10000});
  });
  await check('TC-KAN-008-move-comment',async()=>{
    const board=await client(sender,'board',fixture.slug);
    await recipient.getByLabel(`Move ${fixture.slug.toUpperCase()}-1`).selectOption(board.lanes[1].id);
    await expect(sender.getByRole('dialog').getByText('In progress',{exact:true})).toBeVisible();
    await recipient.getByRole('heading',{name:'Ship workspace kanban',exact:true}).click();
    await recipient.getByLabel('Comment',{exact:true}).fill('Ready for **review**');
    await recipient.getByRole('button',{name:'Add comment',exact:true}).click();
    await expect(sender.getByRole('dialog').getByText('Ready for', {exact:false})).toBeVisible();
    await sender.getByRole('button',{name:'Close ✕',exact:true}).click();
    await recipient.getByRole('button',{name:'Close ✕',exact:true}).click();
  });
  await check('TC-KAN-002-lane-settings-live',async()=>{
    await expect(recipient.getByRole('button',{name:'Manage lanes',exact:true})).toHaveCount(0);
    await sender.getByRole('button',{name:'Manage lanes',exact:true}).click();
    await sender.getByLabel('Lane name 1',{exact:true}).fill('Backlog');
    await sender.getByRole('dialog',{name:'Manage lanes'}).getByRole('button',{name:'Save',exact:true}).first().click();
    await expect(recipient.getByRole('heading',{name:'Backlog',exact:true})).toBeVisible();
    await sender.getByRole('button',{name:'Close ✕',exact:true}).click();
  });
  await check('TC-KAN-004-deadline-notification-deeplink',async()=>{
    ticket=await client(sender,'boardTicket',fixture.slug,ticket.id);
    await client(sender,'updateTicket',fixture.slug,ticket.id,{version:ticket.version,due_at:new Date(Date.now()-60000).toISOString()});
    php(`(new App\\Jobs\\NotifyDueTickets)->handle(); (new App\\Jobs\\NotifyDueTickets)->handle();`);
    await recipient.getByTestId('notification-bell').click();
    await expect(recipient.getByText('Ticket #1 is due',{exact:true})).toBeVisible({timeout:10000});
    await recipient.getByText('Ticket #1 is due',{exact:true}).click();
    await expect(recipient).toHaveURL(new RegExp(`/board/${ticket.id}$`));
    await expect(recipient.getByRole('dialog').getByRole('heading',{name:'Ship workspace kanban',exact:true})).toBeVisible();
    await recipient.getByRole('button',{name:'Close ✕',exact:true}).click();
  });
  await check('TC-KAN-008-mobile-board',async()=>{
    await recipient.setViewportSize({width:390,height:844});
    await expect(recipient.getByRole('heading',{name:'Board.',exact:true})).toBeVisible();
    await expect(recipient.getByRole('button',{name:'+ Create ticket',exact:true})).toBeVisible();
    expect(await recipient.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
  await check('TC-KAN-001-switch-workspace-isolation',async()=>{
    const other=JSON.parse(php(`$w=App\\Models\\Workspace::factory()->create(['slug'=>'${run}other']); $w->members()->attach('${fixture.receiverId}',['role'=>'member']); echo json_encode(['id'=>$w->id,'slug'=>$w->slug]);`));
    try {
      await recipient.reload();
      await recipient.getByRole('button',{name:'Show conversations',exact:true}).click();
      await recipient.getByLabel('Workspace',{exact:true}).selectOption(other.slug);
      await recipient.getByRole('button',{name:'Close conversations',exact:true}).click({position:{x:325,y:100}});
      await expect(recipient.getByRole('heading',{name:'Ship workspace kanban',exact:true})).toHaveCount(0);
      await expect(recipient.getByRole('heading',{name:'To do',exact:true})).toBeVisible();
    } finally {php(`App\\Models\\Workspace::where('id','${other.id}')->delete();`);}
  });
  await check('TC-KAN-008-no-runtime-errors',async()=>expect(errors).toEqual([]));
} finally {
  for (const page of [sender, recipient]) {
    try { await client(page, 'logout'); } catch {}
  }
  for (const context of [senderContext,recipientContext]) await context.unrouteAll({behavior:'ignoreErrors'}).catch(()=>undefined);
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
