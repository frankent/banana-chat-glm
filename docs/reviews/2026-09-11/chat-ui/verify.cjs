// Real production API, queue, storage and Reverb; only this run's fixtures are mutated.
// CHAT_UI_ASSET_ORIGIN optionally serves a candidate build at the same browser origin.
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const requireWeb = createRequire(process.env.CHAT_UI_PLAYWRIGHT_PACKAGE || path.join(root, 'apps/web/package.json'));
const { chromium, expect } = requireWeb('@playwright/test');
const base = 'https://chat.gamecoms.net';
const label = process.env.CHAT_UI_RUN || 'production';
const output = path.join(__dirname, label);
fs.mkdirSync(output, { recursive: true });
function php(code) {
  return execFileSync('ssh', ['-S', process.env.CHAT_UI_SSH_SOCKET || '/tmp/banana-chat-ui-ssh', 'root@165.22.63.119', 'cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php'], {
    input: `<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`, encoding: 'utf8',
  });
}
const prefix = 'chatui' + Date.now();
const password = randomBytes(20).toString('hex');
const fixture = JSON.parse(php(`$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Chat UI QA','status'=>'active']);$users=[];foreach(['QA Sender','QA Recipient'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>$i===0?'owner':'member']);$users[]=['username'=>$u->username,'id'=>$u->id];}echo json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'users'=>$users]);`));
const results = [], errors = [], contexts = [];
let browser, cleanup = false;
(async () => {
  try {
    browser = await chromium.launch({ ...(process.env.CHAT_UI_CHROMIUM ? { executablePath: process.env.CHAT_UI_CHROMIUM } : {}), args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    async function newContext(options = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
      contexts.push(context);
      if (process.env.CHAT_UI_ASSET_ORIGIN) {
        await context.route(base + '/**', async route => {
          const req = route.request(), url = new URL(req.url());
          if (req.method() === 'GET' && (req.resourceType() === 'document' || url.pathname.startsWith('/assets/'))) {
            const response = await route.fetch({ url: process.env.CHAT_UI_ASSET_ORIGIN + url.pathname + url.search });
            return route.fulfill({ response });
          }
          return route.continue();
        });
      }
      return context;
    }
    async function login(index) {
      const context = await newContext(), page = await context.newPage();
      page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/login', { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Username').fill(fixture.users[index].username);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.locator('.bc-sidebar')).toBeVisible();
      await page.waitForFunction(() => window.Pusher?.instances.at(-1)?.connection.state === 'connected');
      return page;
    }
    const sender = await login(0), recipient = await login(1);
    async function check(id, fn, page = sender) {
      const start = Date.now();
      try { results.push({ id, passed: true, details: await fn(), ms: Date.now() - start }); }
      catch (e) { results.push({ id, passed: false, error: e.message, ms: Date.now() - start }); await page.screenshot({ path: path.join(output, id + '.png') }).catch(() => {}); }
      console.log(JSON.stringify(results.at(-1)));
    }
    async function actions(page, row) {
      const toggle = row.getByRole('button', { name: 'Message actions', exact: true });
      if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await expect(row.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
    }
    async function send(page, body) {
      await page.getByTestId('composer-input').fill(body);
      await page.getByTestId('send-button').click();
      const row = page.getByTestId('message').filter({ has: page.locator('.bc-markdown', { hasText: body }) }).first();
      await expect(row).toBeVisible();
      return row;
    }
    async function navigate(page, room) {
      await page.evaluate(room => { history.pushState({}, '', '/rooms/' + room); dispatchEvent(new PopStateEvent('popstate')); }, room);
      await expect(page.getByTestId('composer-input')).toBeVisible();
    }
    let dm, group;
    await check('TC-ROOM-UI-create-dm-and-realtime-list', async () => {
      await sender.getByRole('button', { name: '+ DM', exact: true }).click();
      await sender.getByPlaceholder('Search people…').fill(fixture.users[1].username);
      await sender.getByRole('button', { name: /QA Recipient/ }).click();
      await expect(sender.getByTestId('composer-input')).toBeVisible();
      dm = sender.url().split('/rooms/')[1];
      await expect(recipient.locator(`aside a[href="/rooms/${dm}"]`)).toBeVisible();
      await recipient.locator(`aside a[href="/rooms/${dm}"]`).click();
    });
    if (!dm) throw Error('Cannot continue without an isolated DM');
    const original = 'UI controls original';
    let row;
    await check('TC-MSG-UI-send-and-realtime-delivery', async () => {
      row = await send(sender, original);
      await expect(recipient.getByTestId('message').filter({ hasText: original })).toBeVisible();
    });
    await check('TC-MSG-UI-persistent-actions', async () => {
      await actions(sender, row);
      await sender.mouse.move(0, 0, { steps: 15 });
      const reply = row.getByRole('button', { name: 'Reply', exact: true });
      await expect(reply).toBeVisible();
      const r = await reply.boundingBox();
      await sender.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 15 });
      await reply.click();
      await expect(sender.getByRole('button', { name: 'Cancel reply' })).toBeVisible();
      await sender.getByRole('button', { name: 'Cancel reply' }).click();
    });
    await check('TC-WEB-UI-keyboard-message-actions', async () => {
      await sender.mouse.move(0, 0);
      await sender.getByTestId('composer-input').focus();
      let found = false;
      for (let i = 0; i < 6; i++) {
        await sender.keyboard.press('Shift+Tab');
        found = await sender.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Message actions');
        if (found) break;
      }
      expect(found).toBe(true);
      await sender.keyboard.press('Enter');
      await expect(row.getByRole('button', { name: 'Reply', exact: true })).toBeFocused();
      await sender.keyboard.press('Escape');
      await expect(row.getByRole('button', { name: 'Message actions', exact: true })).toBeFocused();
      await expect(row.getByRole('button', { name: 'Reply', exact: true })).toBeHidden();
    });
    await check('TC-MSG-UI-edit-cancel-save', async () => {
      await actions(sender, row); await row.getByRole('button', { name: 'Edit message' }).click();
      await sender.getByTestId('edit-input').fill('Cancelled edit'); await sender.keyboard.press('Escape');
      await expect(sender.getByTestId('edit-form')).toHaveCount(0); await expect(row).toContainText(original);
      await actions(sender, row); await row.getByRole('button', { name: 'Edit message' }).click();
      await sender.getByTestId('edit-input').fill(original + ' edited'); await sender.getByTestId('edit-save').click();
      await expect(sender.getByTestId('edit-form')).toHaveCount(0);
      await expect(recipient.getByTestId('message').filter({ hasText: original })).toContainText('edited');
    });
    await check('TC-MSG-UI-pin-jump-return-unpin', async () => {
      await actions(sender, row); await row.getByRole('button', { name: 'Pin message' }).click();
      const pins = sender.getByLabel('Pinned messages'); await expect(pins).toContainText(original);
      await pins.getByRole('button').first().click(); await expect(sender).toHaveURL(/around_seq=/);
      await sender.getByRole('button', { name: 'Back to latest messages' }).click();
      await pins.getByRole('button', { name: 'Unpin message' }).click(); await expect(pins).toHaveCount(0);
    });
    await check('TC-MSG-UI-reply-send-and-jump', async () => {
      await actions(sender, row); await row.getByRole('button', { name: 'Reply', exact: true }).click();
      const reply = await send(sender, 'UI quoted response'); await expect(reply.locator('.bc-reply-quote')).toContainText(original);
      await reply.locator('.bc-reply-quote').click(); await expect(sender).toHaveURL(/around_seq=/);
      await sender.getByRole('button', { name: 'Back to latest messages' }).click();
    });
    await check('TC-MSG-UI-delete', async () => {
      const disposable = await send(sender, 'UI delete only this QA message');
      await actions(sender, disposable); await disposable.getByRole('button', { name: 'Delete message' }).click();
      await expect(disposable).toHaveCount(0); await expect(recipient.getByTestId('deleted-placeholder')).toBeVisible();
    });
    await check('TC-MSG-UI-enter-newline-and-typing', async () => {
      await sender.getByTestId('composer-input').fill('UI first line');
      await expect(recipient.getByTestId('typing-indicator')).toContainText('QA Sender');
      await sender.keyboard.press('Shift+Enter'); await sender.keyboard.type('second line');
      await expect(sender.getByTestId('composer-input')).toHaveValue('UI first line\nsecond line');
      await sender.keyboard.press('Enter');
      await expect(recipient.getByTestId('message').filter({ hasText: 'UI first line' })).toContainText('second line');
    });
    await check('TC-MSG-UI-mention-keyboard', async () => {
      await sender.getByTestId('composer-input').fill('@'); await expect(sender.getByTestId('mention-popup')).toBeVisible();
      await sender.keyboard.press('ArrowDown'); await sender.keyboard.press('Enter');
      await expect(sender.getByTestId('mention-popup')).toHaveCount(0);
      await expect(sender.getByTestId('composer-input')).toHaveValue(/@\w+ /); await sender.getByTestId('composer-input').fill('');
    });
    await check('TC-NOTE-UI-create-edit-cancel-delete', async () => {
      await sender.getByRole('button', { name: 'Room notes', exact: true }).click();
      await sender.getByLabel('Note text').fill('UI shared note'); await sender.getByRole('button', { name: 'Create note', exact: true }).click();
      await expect(sender.getByTestId('room-note')).toContainText('UI shared note');
      await sender.getByRole('button', { name: 'Edit note' }).click(); await sender.getByRole('button', { name: 'Cancel', exact: true }).click();
      await sender.getByRole('button', { name: 'Edit note' }).click(); await sender.getByLabel('Note text').fill('UI note edited');
      await sender.getByRole('button', { name: 'Save changes' }).click(); await expect(sender.getByTestId('room-note')).toContainText('UI note edited');
      await sender.getByRole('button', { name: 'Delete note' }).click(); await expect(sender.getByTestId('room-note')).toHaveCount(0);
      await sender.getByRole('button', { name: 'Close notes' }).click();
    });
    await check('TC-MEDIA-UI-upload-text-preview-download', async () => {
      const picker = sender.waitForEvent('filechooser'); await sender.getByTestId('attach-button').click();
      await (await picker).setFiles({ name: 'ui-preview.txt', mimeType: 'text/plain', buffer: Buffer.from('Chat UI preview content') });
      await expect(sender.getByTestId('send-button')).toBeEnabled({ timeout: 45000 });
      await sender.getByTestId('composer-input').fill('UI text attachment'); await sender.getByTestId('send-button').click();
      const file = sender.getByTestId('message').filter({ hasText: 'UI text attachment' }).getByTestId('attachment-file');
      await expect(file).toBeVisible({ timeout: 45000 }); await file.click();
      const viewer = sender.getByRole('dialog'); await expect(viewer).toContainText('Chat UI preview content');
      const download = await viewer.getByRole('link', { name: 'Download' }).getAttribute('href');
      expect((await sender.request.get(download)).ok()).toBe(true);
      await sender.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
    });
    await check('TC-MEDIA-UI-upload-image-zoom-fit-close', async () => {
      const png = await sender.evaluate(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 60; const ctx = c.getContext('2d'); ctx.fillStyle = '#6e8a56'; ctx.fillRect(0, 0, 80, 60); return c.toDataURL('image/png').split(',')[1]; });
      const picker = sender.waitForEvent('filechooser'); await sender.getByTestId('attach-button').click();
      await (await picker).setFiles({ name: 'ui-preview.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(sender.getByTestId('send-button')).toBeEnabled({ timeout: 45000 });
      await sender.getByTestId('composer-input').fill('UI image attachment'); await sender.getByTestId('send-button').click();
      const image = sender.getByTestId('message').filter({ hasText: 'UI image attachment' }).getByRole('button', { name: 'View ui-preview.png' });
      await expect(image).toBeVisible({ timeout: 45000 });
      await expect(recipient.getByTestId('message').filter({ hasText: 'UI image attachment' }).getByTestId('attachment-image')).toBeVisible({ timeout: 15000 });
      await image.click();
      await expect.poll(() => sender.getByRole('dialog').locator('img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
      await sender.getByRole('button', { name: 'Zoom', exact: true }).click(); await expect(sender.getByRole('dialog').locator('img')).toHaveClass('zoom');
      await sender.getByRole('button', { name: 'Fit', exact: true }).click(); await sender.getByRole('button', { name: 'Close viewer' }).click();
    });
    await check('TC-MEDIA-UI-panel-filters-jump', async () => {
      await sender.getByTestId('room-media-toggle').click();
      for (const name of ['Images', 'Videos', 'Files', 'All']) { await sender.getByRole('tab', { name, exact: true }).click(); await expect(sender.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true'); }
      await sender.getByLabel('Filter by name').fill('ui-preview.txt');
      await expect(sender.getByTestId('room-media-item')).toHaveCount(1); await sender.getByTestId('room-media-item').click();
      await expect(sender).toHaveURL(/around_seq=/); await expect(sender.getByTestId('composer-input')).toBeVisible();
      await sender.getByRole('button', { name: 'Back to latest messages' }).click();
    });
    await check('TC-ROOM-UI-create-long-name-group', async () => {
      await sender.getByRole('button', { name: '+ Group', exact: true }).click();
      await sender.getByPlaceholder('Group name').fill('QA long conversation title for responsive chat controls');
      await sender.getByPlaceholder('Search people…').fill(fixture.users[1].username);
      await sender.getByRole('button', { name: /QA Recipient/ }).click();
      await sender.getByRole('button', { name: /Create group/ }).click();
      await expect(sender.locator('.bc-chat-identity')).toContainText('QA long conversation title');
      group = sender.url().split('/rooms/')[1];
    });
    await check('TC-MSG-UI-draft-room-switch', async () => {
      await sender.getByTestId('composer-input').fill('UI unsent draft'); await navigate(sender, dm); await expect(sender.getByTestId('composer-input')).toHaveValue('');
      await navigate(sender, group); await expect(sender.getByTestId('composer-input')).toHaveValue('UI unsent draft'); await sender.getByTestId('composer-input').fill('');
    });
    for (const width of [1440, 1024, 820, 768, 760, 390, 320]) {
      await sender.setViewportSize({ width, height: 844 });
      await check('TC-WEB-UI-responsive-controls-' + width, async () => {
        const controls = await sender.locator('.bc-chat-header').getByRole('button').evaluateAll(bs => bs.map(b => { const r = b.getBoundingClientRect(); return { name: b.ariaLabel, right: r.right, hit: b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; }));
        expect(controls.every(b => b.hit && b.right <= width)).toBe(true);
        await expect(sender.getByTestId('send-button')).toBeInViewport();
        expect(await sender.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await sender.screenshot({ path: path.join(output, 'chat-' + width + '.png') });
        return { width, controls };
      });
      if ([820, 390, 320].includes(width)) {
        await check('TC-WEB-UI-side-panels-' + width, async () => {
          await sender.getByRole('button', { name: 'Room notes', exact: true }).click();
          await expect(sender.getByRole('button', { name: 'Close notes' })).toBeInViewport(); await sender.getByRole('button', { name: 'Close notes' }).click();
          await sender.getByTestId('room-media-toggle').click(); await expect(sender.getByRole('button', { name: 'Close media panel' })).toBeInViewport();
          await sender.getByRole('tab', { name: 'Images', exact: true }).click(); await sender.getByRole('button', { name: 'Close media panel' }).click();
        });
      }
    }
    await check('TC-WEB-UI-search-mobile', async () => {
      await sender.setViewportSize({ width: 320, height: 844 }); await sender.getByTestId('open-search').click();
      await sender.getByTestId('search-input').fill('UI controls'); await sender.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(sender.getByTestId('search-result-message').first()).toBeVisible();
      const filter = await sender.getByTestId('search-room-filter').boundingBox(); expect(filter.x + filter.width).toBeLessThanOrEqual(320);
      await sender.getByTestId('search-room-filter').selectOption(dm); await expect(sender.getByTestId('search-result-message').first()).toBeVisible();
      await sender.screenshot({ path: path.join(output, 'mobile-search.png') });
      await sender.getByTestId('search-result-message').first().click(); await expect(sender).toHaveURL(/around_seq=/);
      await sender.getByRole('button', { name: 'Back to latest messages' }).click();
    });
    await check('TC-WEB-UI-mobile-navigation-and-actions', async () => {
      await sender.getByRole('button', { name: 'Show conversations', exact: true }).click(); await expect(sender.locator('.bc-sidebar')).toBeVisible();
      await sender.locator(`aside a[href="/rooms/${group}"]`).click(); await expect(sender.locator('.bc-sidebar')).toBeHidden();
      const mobile = await send(sender, 'UI mobile action'); await mobile.getByRole('button', { name: 'Reply', exact: true }).click();
      await sender.getByRole('button', { name: 'Cancel reply' }).click();
      await mobile.getByRole('button', { name: 'Delete message' }).click(); await expect(mobile).toHaveCount(0);
    });
    await sender.setViewportSize({ width: 1440, height: 900 });
    await check('TC-NOTI-UI-sound-and-dismiss', async () => {
      await sender.getByTestId('notification-bell').click(); const toggle = sender.getByLabel('Notification sound'); const was = await toggle.isChecked();
      await toggle.click(); await expect(toggle).toBeChecked({ checked: !was }); await expect(toggle).toBeEnabled();
      await toggle.click(); await expect(toggle).toBeChecked({ checked: was }); await sender.keyboard.press('Escape');
      await expect(sender.getByTestId('notification-panel')).toHaveCount(0);
    });
    await navigate(sender, dm);
    for (const kind of ['voice', 'video']) {
      await check('TC-CALL-UI-' + kind + '-controls', async () => {
        await sender.getByRole('button', { name: 'Start ' + kind + ' call', exact: true }).click();
        const stage = sender.getByRole('dialog', { name: kind === 'voice' ? 'Voice call' : 'Video call', exact: true });
        try {
          await expect(stage).toBeVisible();
          await expect(recipient.locator('.bc-call-incoming')).toBeVisible();
          await recipient.locator('.bc-call-incoming').getByRole('button', { name: 'Join', exact: true }).click();
          await expect(stage.locator('.bc-call-count')).toContainText('2 participants', { timeout: 30000 });
          const mic = stage.locator('button[data-lk-source="microphone"]');
          await expect(mic).toHaveAttribute('aria-pressed', 'true');
          await mic.click(); await expect(mic).toHaveAttribute('aria-pressed', 'false');
          await mic.click(); await expect(mic).toHaveAttribute('aria-pressed', 'true');
          if (kind === 'video') {
            const camera = stage.locator('button[data-lk-source="camera"]');
            await expect(camera).toHaveAttribute('aria-pressed', 'true');
            await camera.click(); await expect(camera).toHaveAttribute('aria-pressed', 'false');
            await camera.click(); await expect(camera).toHaveAttribute('aria-pressed', 'true');
          }
          await stage.getByRole('button', { name: 'Minimize call' }).click(); await expect(stage).toHaveClass(/is-minimized/);
          await stage.getByRole('button', { name: 'Expand call' }).click(); await expect(stage).not.toHaveClass(/is-minimized/);
          await sender.setViewportSize({ width: 390, height: 844 });
          await expect(stage.getByRole('button', { name: 'Leave', exact: true })).toBeInViewport();
          await sender.screenshot({ path: path.join(output, kind + '-call-mobile.png') });
          await stage.getByRole('button', { name: 'End for everyone' }).click();
          await expect(stage).toHaveCount(0); await expect(recipient.getByRole('dialog')).toHaveCount(0);
        } finally {
          const end = stage.getByRole('button', { name: 'End for everyone' });
          if (await end.isVisible()) await end.click();
          await sender.setViewportSize({ width: 1440, height: 900 });
        }
      });
    }
    await check('TC-CALL-UI-decline-and-leave', async () => {
      await sender.getByRole('button', { name: 'Start voice call' }).click();
      await expect(recipient.locator('.bc-call-incoming')).toBeVisible();
      await recipient.locator('.bc-call-incoming').getByRole('button', { name: 'Decline' }).click();
      await expect(recipient.locator('.bc-call-incoming')).toHaveCount(0);
      await sender.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
      await expect(sender.getByRole('dialog')).toHaveCount(0);
    });
    const touchContext = await newContext({ storageState: await sender.context().storageState(), viewport: { width: 1024, height: 844 }, hasTouch: true, isMobile: true });
    const touch = await touchContext.newPage(); touch.setDefaultTimeout(10000);
    await touch.goto(base + '/rooms/' + dm, { waitUntil: 'domcontentloaded' }); await expect(touch.getByTestId('composer-input')).toBeVisible();
    await check('TC-WEB-UI-tablet-touch-actions', async () => {
      expect(await touch.evaluate(() => matchMedia('(hover:none)').matches)).toBe(true);
      const tabletRow = touch.getByTestId('message').filter({ has: touch.locator('.bc-markdown', { hasText: original }) }).first();
      await expect(tabletRow.getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
      await tabletRow.getByRole('button', { name: 'Reply', exact: true }).tap(); await touch.getByRole('button', { name: 'Cancel reply' }).tap();
      await touch.screenshot({ path: path.join(output, 'tablet-touch.png') });
    }, touch);
    await check('TC-WEB-UI-runtime-errors', async () => { expect(errors).toEqual([]); });
  } finally {
    if (browser) await browser.close();
    php(`$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->firstOrFail();Illuminate\\Support\\Facades\\Storage::disk(config('filesystems.default'))->deleteDirectory('ws/'.$w->id);Illuminate\\Support\\Facades\\DB::transaction(function()use($w){$w->delete();App\\Models\\User::whereIn('id',${JSON.stringify(fixture.users.map(u => u.id)).replaceAll('[', '[').replaceAll(']', ']')})->where('username','like','${prefix}%')->delete();});`);
    cleanup = true;
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ candidateAssets: Boolean(process.env.CHAT_UI_ASSET_ORIGIN), results, errors, cleanup }, null, 2));
  }
  if (results.some(r => !r.passed)) process.exitCode = 1;
})().catch(e => { console.error(e); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, cleanup, fatal: e.message }, null, 2)); process.exitCode = 1; });
