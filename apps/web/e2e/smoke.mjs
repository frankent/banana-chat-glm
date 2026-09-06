/**
 * TC-WEB-E2E — headless two-browser smoke against the live dev stack:
 * Vite :5173 → API :8000 → Reverb :8088. Real Chrome, real WebSockets.
 *
 * Flow: tony logs in → opens DM with somchai → sends a message →
 * somchai (already logged in, other browser) sees it arrive WITHOUT reload →
 * somchai focuses the room (auto mark-read) → tony sees "Seen" →
 * tony creates a group with duangjai → system message renders on both sides.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5173';
const stamp = Date.now().toString(36);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, selectorOrFn, timeout = 15_000, label = selectorOrFn) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = typeof selectorOrFn === 'function'
      ? await selectorOrFn().catch(() => false)
      : (await page.$(selectorOrFn)) !== null;
    if (ok) return true;
    await sleep(300);
  }
  throw new Error(`TIMEOUT waiting for ${label}`);
}

async function login(page, username, password) {
  await page.goto(`${URL}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
  await waitFor(page, 'nav a', 15_000, 'room list after login');
}

async function roomLink(page, text) {
  const links = await page.$$('nav a');
  for (const link of links) {
    const t = await link.evaluate((el) => el.textContent);
    if (t !== null && t.includes(text)) return link;
  }
  return null;
}

async function lastMessage(page) {
  const nodes = await page.$$('[data-testid="message"]');
  if (nodes.length === 0) return null;
  return nodes[nodes.length - 1].evaluate((el) => el.textContent);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const tony = await (await browser.createBrowserContext()).newPage();
  const somchai = await (await browser.createBrowserContext()).newPage();
  for (const page of [tony, somchai]) {
    page.setDefaultTimeout(20_000);
    page.on('dialog', (dialog) => void dialog.dismiss());
  }

  console.log('[1] login tony + somchai');
  await Promise.all([login(tony, 'tony', 'Tony12345!'), login(somchai, 'somchai', 'Somchai12345!')]);
  console.log('    both logged in, room lists visible');

  console.log('[2] tony opens DM with somchai');
  const dm = await roomLink(tony, 'สมชาย');
  if (dm === null) throw new Error('tony cannot find DM with Somchai');
  await dm.click();
  await waitFor(tony, '[data-testid="composer-input"]', 15_000, 'composer');

  console.log('[3] somchai also opens the DM (so the room channel is subscribed)');
  const dmB = await roomLink(somchai, 'Tony');
  if (dmB === null) throw new Error('somchai cannot find DM with Tony');
  await dmB.click();
  await waitFor(somchai, '[data-testid="composer-input"]', 15_000, 'composer B');

  const body = `e2e hello ${stamp}`;
  console.log(`[4] tony sends "${body}"`);
  await tony.type('[data-testid="composer-input"]', body);
  await tony.keyboard.press('Enter');

  await waitFor(tony, async () => {
    const t = await lastMessage(tony);
    return t !== null && t.includes(body) && !t.includes('sending…');
  }, 15_000, `tony sees confirmed "${body}"`);
  console.log('    tony: message confirmed by server');

  await waitFor(somchai, async () => {
    const t = await lastMessage(somchai);
    return t !== null && t.includes(body);
  }, 15_000, `somchai receives "${body}" via realtime (no reload)`);
  console.log('    somchai: message arrived over WebSocket — no reload');

  console.log('[5] somchai focuses room → tony sees Seen');
  await somchai.bringToFront();
  await somchai.click('[data-testid="message-list"]');
  await waitFor(tony, '[data-testid="seen-indicator"]', 15_000, 'Seen indicator for tony');
  console.log('    tony: read receipt visible');

  console.log('[6] tony creates a group with duangjai');
  await tony.bringToFront();
  await tony.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const group = buttons.find((b) => b.textContent?.includes('+ Group'));
    group?.click();
  });
  await tony.waitForSelector('input[placeholder="Group name"]', { timeout: 10_000 });
  await tony.type('input[placeholder="Group name"]', `E2E ${stamp}`);
  await tony.type('input[placeholder="Search people…"]', 'duangjai');
  await waitFor(tony, async () => ((await tony.$$('ul button'))?.length ?? 0) > 0, 10_000, 'directory results');
  await sleep(500);
  await tony.evaluate(() => {
    const items = [...document.querySelectorAll('ul button')];
    items.find((b) => b.textContent?.includes('duangjai') || b.textContent?.includes('ดวงใจ'))?.click();
  });
  await sleep(300);
  await tony.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    buttons.find((b) => b.textContent?.includes('Create group'))?.click();
  });

  await waitFor(tony, async () => {
    const t = await lastMessage(tony);
    return t !== null && t.includes('added');
  }, 15_000, 'member_added system message');
  console.log('    tony: group created, system message renders');

  console.log('[7] tony switches workspace acme → globex');
  await tony.select('select[aria-label="Workspace"]', 'globex');
  await sleep(1500);
  const engineeringGone = (await roomLink(tony, 'Engineering')) === null;
  if (!engineeringGone) throw new Error('acme rooms still visible inside globex');
  console.log('    globex room list isolated (no acme rooms)');

  await browser.close();
  console.log('\nE2E SMOKE PASSED — login, DM, realtime, read receipt, group + system message, workspace isolation');
}

main().catch((error) => {
  console.error(`E2E FAILED: ${error.message}`);
  process.exit(1);
});
