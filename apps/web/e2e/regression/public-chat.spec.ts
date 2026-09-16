import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * FR-PCHAT — public support chat, end to end against the LOCAL dev stack.
 *
 *   web :5173 (Vite, `baseURL` from playwright.config.ts) → api :8000 (docker)
 *   → reverb :8088 · Filament admin at :8000/admin in the same api container.
 *
 * NOTHING HERE POINTS AT PRODUCTION. Every SPA navigation is a relative path so
 * it resolves against `baseURL`; the two absolute URLs are `localhost:8000`
 * (the admin panel and the partner API), matching admin.spec.ts / fixtures.ts.
 *
 * ===== WHY THIS SPEC BOOTSTRAPS ITS OWN DATA ==============================
 * There is no public-chat seeder, and there deliberately is no agent-side
 * "create conversation" control — a support room exists only because a PARTNER
 * created it over the Tier-1 HMAC API (FR-PCHAT-001). So the suite mints what
 * it needs, in the same order a real integration does:
 *
 *   1. admin enables `publicchat.enabled`   — FR-PCHAT-034: the feature SHIPS
 *      DISABLED, so on a fresh stack every visitor/agent write 503s until an
 *      admin opts in. This is the step that makes the rest of the run possible.
 *   2. admin issues a partner API key        — FR-PCHAT-030, the one and only
 *      moment the plaintext secret is ever shown (a persistent Filament
 *      notification; it is never retrievable again).
 *   3. the spec signs API-200 itself         — FR-PCHAT-031, HMAC-SHA256 over
 *      the six-line canonical string, and takes `/support/<code>` from the
 *      response the way the partner's server would.
 *
 * ===== RUNNING IT =========================================================
 *   cd apps/web && npx playwright test public-chat
 * Requires `make up && make migrate && make seed` (users tony/anna, workspace
 * "Acme Corp") plus the Vite dev server. The whole file is `serial`: step 1
 * gates every later step, and the room created in step 1 is the subject of all
 * of them. A failure in an early test skips the rest rather than reporting a
 * cascade of unrelated red.
 *
 * ===== LOGIN BUDGET =======================================================
 * FR-AUTH-006 throttles login 5/min/IP and 10/15min/username, and the rest of
 * the regression suite already spends ~7 of tony's. This file therefore logs
 * tony in EXACTLY ONCE (`agentPage()` memoises the context) and reuses that one
 * page across every agent-side test. Do not add a second `uiLogin(…, 'tony')`.
 */

const ADMIN = 'http://localhost:8000/admin';
const API = 'http://localhost:8000/api/v1';

/** Distinguishes this run's rows from every previous run's leftovers. */
const stamp = Date.now().toString(36);
const CUSTOMER = `PW Customer ${stamp}`;
const PROVIDER = `PW Provider ${stamp}`;
const EXTERNAL_REF = `PW-${stamp}`;
/** The agent whose username must appear inside the customer-facing label. */
const AGENT_USERNAME = 'tony';

/** Filled by the bootstrap test; read by every test after it. */
const partner = {
  keyId: '',
  secret: '',
  code: '',
  roomId: '',
};

// ---------------------------------------------------------------------------
// Tier 1 — signing a partner request exactly the way the middleware verifies it
// ---------------------------------------------------------------------------

/**
 * FR-PCHAT-031. The canonical string is SIX lines joined by "\n":
 *
 *   v1 / METHOD / path incl. the /api/v1 prefix, no query / timestamp / nonce /
 *   lowercase hex sha256 of the RAW body bytes (sha256("") when there is none)
 *
 * The body is serialised ONCE into `body` and that exact string is both hashed
 * and put on the wire. Re-serialising for the digest changes key order,
 * whitespace and unicode escaping and produces intermittent signature failures
 * — the single most common integration bug in this class of API, and the reason
 * the middleware hashes `$request->getContent()` rather than the parsed array.
 */
async function partnerRequest(
  method: 'POST' | 'GET',
  path: string,
  payload?: unknown,
): Promise<{ status: number; json: any }> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  // randomUUID is 36 chars of [A-Za-z0-9-] — inside the middleware's
  // \A[A-Za-z0-9_-]{16,64}\z nonce shape, and unique per call so the 600s
  // replay cache never rejects a legitimate retry of a DIFFERENT request.
  const nonce = randomUUID();

  const canonical = [
    'v1',
    method,
    `/api/v1${path}`,
    timestamp,
    nonce,
    createHash('sha256').update(body, 'utf8').digest('hex'),
  ].join('\n');

  const signature = createHmac('sha256', partner.secret).update(canonical, 'utf8').digest('hex');

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-PChat-Key': partner.keyId,
      'X-PChat-Timestamp': timestamp,
      'X-PChat-Nonce': nonce,
      'X-PChat-Signature': `v1=${signature}`,
    },
    body: method === 'GET' ? undefined : body,
  });

  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// Shared agent session — ONE tony login for the whole file (see LOGIN BUDGET)
// ---------------------------------------------------------------------------

let agentContext: BrowserContext | null = null;
let agent: Page | null = null;

async function agentPage(
  browser: import('@playwright/test').Browser,
  uiLogin: (page: Page, username: string, password: string) => Promise<void>,
): Promise<Page> {
  if (agent !== null) {
    return agent;
  }
  agentContext = await browser.newContext();
  agent = await agentContext.newPage();
  await uiLogin(agent, 'tony', 'Tony12345!');
  return agent;
}

test.afterAll(async () => {
  await agentContext?.close();
  agentContext = null;
  agent = null;
});

async function adminLogin(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/login`);
  // custom Filament login: statePath "data" ⇒ ids data.login / data.password
  await page.fill('#data\\.login', 'admin');
  await page.fill('#data\\.password', 'Admin12345!');
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/login$/, { timeout: 30_000 });
}

// ===========================================================================

test.describe.serial('FR-PCHAT public chat', () => {
  test('TC-PCHAT-052 admin enables the feature, issues a partner key, and the partner creates a room', async ({
    page,
    shot,
  }) => {
    test.setTimeout(120_000);
    await adminLogin(page);

    // ---- FR-PCHAT-034: the kill switch. Ships OFF (DEC-067) --------------
    // The Settings page builds its fields from SettingsService::DEFAULTS and
    // labels each one `ucwords(str_replace(['.','_'],' ',$key))`, so
    // `publicchat.enabled` renders as the toggle "Publicchat Enabled".
    await page.goto(`${ADMIN}/settings`);
    const killSwitch = page.getByLabel('Publicchat Enabled');
    await expect(killSwitch).toBeVisible({ timeout: 20_000 });
    await shot(page, '01-settings-before');

    // A Filament Toggle is a role=switch button; aria-checked is its state.
    if ((await killSwitch.getAttribute('aria-checked')) !== 'true') {
      await killSwitch.click();
      await page.getByRole('button', { name: /Save|บันทึก/ }).first().click();
      await expect(page.getByText('Settings saved')).toBeVisible({ timeout: 20_000 });
    }
    await expect(killSwitch).toHaveAttribute('aria-checked', 'true');
    await shot(page, '02-feature-enabled');

    // ---- FR-PCHAT-030: issuance is a TABLE HEADER action ------------------
    // Not a page-level CreateAction: ListPublicChatApiKeys registers none on
    // purpose, because a page-level create would raw-insert a row with no
    // key_id and no secret_ciphertext.
    await page.goto(`${ADMIN}/public-chat-api-keys`);
    await page.getByRole('button', { name: 'ออก API key' }).click();

    const modal = page.locator('.fi-modal-window');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    // Filament's searchable Select is a Choices.js combobox, not a <select>:
    // click it, then pick the option by its visible text.
    await modal.getByLabel('Workspace').click();
    await page.getByRole('option', { name: 'Acme Corp' }).click();
    await modal.getByLabel('ชื่อ (อ้างอิงภายใน)').fill(`Playwright ${stamp}`);
    await shot(page, '03-issue-modal');
    await modal.getByRole('button', { name: 'ออก key' }).click();

    // THE ONE AND ONLY TIME THE SECRET IS EVER SHOWN. The notification is
    // ->persistent() precisely so it stays on screen until dismissed; after
    // this it is unreadable through any UI, API, export or form (model
    // $hidden + DEC-062 encryption at rest).
    // Filament 3.3's notification container (NOT v4 — composer.json pins ^3.3,
    // composer.lock resolves v3.3.55). `.fi-no` is the Notifications component
    // wrapper; reading the whole container rather than one notification keeps
    // this working whether or not a "saved" toast is still on screen.
    const notification = page.locator('.fi-no-notification, .fi-no').first();
    await expect(notification).toBeVisible({ timeout: 20_000 });
    const announced = (await notification.innerText()).replace(/\s+/g, ' ');
    await shot(page, '04-secret-notification');

    // key_id is 'pck_' + 28 lowercase hex and is PUBLIC; the secret is
    // 'pcs_' + 64 hex — a shape gitleaks/GitHub can pattern-match, which is
    // the stated reason for the prefix.
    const keyId = announced.match(/pck_[0-9a-f]{28}/)?.[0];
    const secret = announced.match(/pcs_[0-9a-f]{64}/)?.[0];
    expect(keyId, `no key_id in the issuance notification: ${announced}`).toBeTruthy();
    expect(secret, 'no plaintext secret in the issuance notification').toBeTruthy();
    partner.keyId = keyId as string;
    partner.secret = secret as string;

    // The table shows the key_id and ****last4 — never the secret itself.
    await expect(page.getByText(partner.keyId).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(partner.secret)).toHaveCount(0);

    // ---- API-200: the partner creates the room ---------------------------
    // external_ref is stamped, so a re-run creates a NEW room rather than
    // getting a 200 idempotent replay of a previous run's conversation.
    const created = await partnerRequest('POST', '/partner/public-chat/rooms', {
      customer_name: CUSTOMER,
      provider_name: PROVIDER,
      external_ref: EXTERNAL_REF,
      locale: 'en',
      meta: { source: 'playwright-regression' },
    });

    expect(created.status, `API-200 failed: ${JSON.stringify(created.json)}`).toBe(201);
    expect(created.json.room.status).toBe('new');
    expect(created.json.room.customer_name).toBe(CUSTOMER);
    // The response hands back the capability URL the partner delivers to its
    // customer: /support/<64 lowercase hex>.
    expect(created.json.url).toMatch(/\/support\/[a-f0-9]{64}$/);

    partner.code = created.json.url.split('/support/')[1];
    partner.roomId = created.json.room.id;
    expect(partner.code).toHaveLength(64);

    // API-200 is idempotent on external_ref — the partner's retry after a
    // timeout must not open a second conversation (200, same room, not 201).
    const replay = await partnerRequest('POST', '/partner/public-chat/rooms', {
      customer_name: CUSTOMER,
      provider_name: PROVIDER,
      external_ref: EXTERNAL_REF,
      locale: 'en',
    });
    expect(replay.status).toBe(200);
    expect(replay.json.room.id).toBe(partner.roomId);
  });

  test('TC-PCHAT-053 FR-PCHAT-003 — the Public Chat rail entry appears and opens the queue', async ({
    browser,
    uiLogin,
    shot,
  }) => {
    // TC-PCHAT-052 mints the key, the room and the code this test needs. Running
    // this test alone (`-g TC-PCHAT-05x`) would otherwise fail deep inside the
    // page with an empty id rather than saying why.
    test.skip(partner.code === '', 'bootstrapped by TC-PCHAT-052 — run the whole file');
    const page = await agentPage(browser, uiLogin);

    const rail = page.getByRole('button', { name: 'Public Chat' });
    await expect(rail).toBeVisible({ timeout: 20_000 });
    await shot(page, '01-rail');

    await rail.click();
    await expect(page).toHaveURL(/\/public-chat$/);
    await expect(page.getByRole('heading', { name: /Public Chat/ })).toBeVisible({ timeout: 20_000 });

    // MANDATORY co-edit (a): the Conversations button's active test is a
    // NEGATIVE-match chain, so without the `/public-chat` exclusion BOTH rail
    // items light up at once. Exactly one rail item may be active.
    await expect(page.locator('nav.bc-rail button.active')).toHaveCount(1);
    await expect(rail).toHaveClass(/active/);
    await shot(page, '02-queue-open');
  });

  test('TC-PCHAT-054 FR-PCHAT-004/005 — the queue shows status and assignee, and filters by both', async ({
    browser,
    uiLogin,
    shot,
  }) => {
    // TC-PCHAT-052 mints the key, the room and the code this test needs. Running
    // this test alone (`-g TC-PCHAT-05x`) would otherwise fail deep inside the
    // page with an empty id rather than saying why.
    test.skip(partner.code === '', 'bootstrapped by TC-PCHAT-052 — run the whole file');
    const page = await agentPage(browser, uiLogin);
    await page.goto('/public-chat');

    // The row carries the customer (bold), the provider (muted), a STATUS PILL
    // and the assignee — "Unassigned" until someone claims it.
    const row = page.getByRole('button').filter({ hasText: CUSTOMER });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(PROVIDER);
    await expect(row).toContainText('New');
    await expect(row).toContainText('Unassigned');
    await shot(page, '01-row-status-and-assignee');

    // ---- status filter ---------------------------------------------------
    // Every filter is SERVER-SIDE (API-220) and part of the react-query key;
    // the page never filters a list it already fetched, or "Problem only"
    // would silently mean "problem rooms that were on page 1".
    const statusFilter = page.getByRole('group', { name: 'Filter status' });
    await statusFilter.getByRole('button', { name: 'New', exact: true }).click();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, '02-filter-new');

    await statusFilter.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await shot(page, '03-filter-done-excludes');

    await statusFilter.getByRole('button', { name: 'All', exact: true }).click();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // ---- assignee filter -------------------------------------------------
    const assignee = page.getByLabel('Assigned to');
    await assignee.selectOption('none'); // Unassigned
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, '04-filter-unassigned');

    await assignee.selectOption('me'); // nobody has claimed it yet
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await shot(page, '05-filter-me-excludes');

    await assignee.selectOption('all');
    await expect(row).toBeVisible({ timeout: 15_000 });
  });

  test('TC-PCHAT-055 FR-PCHAT-009 — replying AUTO-CLAIMS the room and flips it to in progress', async ({
    browser,
    uiLogin,
    shot,
  }) => {
    // TC-PCHAT-052 mints the key, the room and the code this test needs. Running
    // this test alone (`-g TC-PCHAT-05x`) would otherwise fail deep inside the
    // page with an empty id rather than saying why.
    test.skip(partner.code === '', 'bootstrapped by TC-PCHAT-052 — run the whole file');
    const page = await agentPage(browser, uiLogin);
    await page.goto(`/public-chat/${partner.roomId}`);

    await expect(page.getByRole('heading', { name: CUSTOMER })).toBeVisible({ timeout: 20_000 });
    // Before the reply: status `new`, nobody claimed it.
    await expect(page.getByLabel('Status')).toHaveValue('new');
    await expect(page.getByText('Not claimed yet')).toBeVisible();
    await shot(page, '01-before-reply');

    // NO CALL AND NO MEETING CONTROL EXISTS ON THE AGENT SIDE EITHER. This is
    // structural, not a hidden button: `ChatView` (which renders CallButtons)
    // is deliberately not reused here, and CallService::allowed() joins
    // `rooms`, where a public chat room id does not resolve at all.
    await expect(page.getByRole('button', { name: 'Start voice call' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start video call' })).toHaveCount(0);

    const reply = `pw-agent-reply ${stamp}`;
    await page.getByLabel('Write a reply...').fill(reply);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText(reply)).toBeVisible({ timeout: 20_000 });
    await shot(page, '02-reply-sent');

    // THE CLAIM IS SERVER-SIDE, inside the same lockForUpdate transaction that
    // assigns `seq` — the client neither asks for it nor races it, so "exactly
    // one claim" is a database guarantee. The UI just reflects the new row.
    await expect(page.getByLabel('Status')).toHaveValue('in_progress', { timeout: 20_000 });
    await expect(page.getByText(/Claimed by/)).toBeVisible({ timeout: 20_000 });
    // Auto-claim also writes a `claimed` system row into the transcript.
    await expect(page.getByText(/claimed this conversation/)).toBeVisible({ timeout: 20_000 });
    await shot(page, '03-auto-claimed');

    // …and the queue now agrees: the room is in progress AND assigned to me.
    await page.goto('/public-chat');
    const row = page.getByRole('button').filter({ hasText: CUSTOMER });
    await expect(row).toContainText('In progress', { timeout: 20_000 });
    await expect(row).not.toContainText('Unassigned');

    await page.getByRole('group', { name: 'Filter status' }).getByRole('button', { name: 'In progress', exact: true }).click();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Assigned to').selectOption('me');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, '04-queue-in-progress-mine');
  });

  test('TC-PCHAT-056 FR-PCHAT-007/014 — /support/<code> loads with no login, can send, offers NO call or meeting, and shows the agent as "provider (username)"', async ({
    browser,
    shot,
  }) => {
    test.setTimeout(120_000);
    // TC-PCHAT-052 mints the key, the room and the code this test needs. Running
    // this test alone (`-g TC-PCHAT-05x`) would otherwise fail deep inside the
    // page with an empty id rather than saying why.
    test.skip(partner.code === '', 'bootstrapped by TC-PCHAT-052 — run the whole file');

    // A GENUINELY ANONYMOUS CONTEXT. This must NOT reuse the agent context:
    // the shared ApiClient attaches whatever bearer it finds, the server would
    // answer viewer:{kind:'member'}, and FR-PCHAT-013 would replace the
    // composer with "You are signed in as …" instead of letting us send.
    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();

    try {
      await visitor.goto(`/support/${partner.code}`);

      // Loads with no session at all — the 64-hex code IS the credential
      // (DEC-063). Nothing here required a login, a workspace or a token.
      await expect(visitor.getByRole('heading', { name: new RegExp(PROVIDER) })).toBeVisible({ timeout: 30_000 });
      await expect(visitor.getByText(CUSTOMER)).toBeVisible();
      await expect(visitor).toHaveURL(new RegExp(`/support/${partner.code}$`));
      // localStorage is empty: proof the page is not riding a session.
      expect(await visitor.evaluate(() => window.localStorage.getItem('orgchat.refresh'))).toBeNull();
      await shot(visitor, '01-visitor-page');

      // ---- NO CALL AND NO MEETING CONTROL (FR-PCHAT-007) -----------------
      // Structural: /support/:code is declared OUTSIDE both <EchoProvider> and
      // <CallProvider>, so CallButtons cannot mount even by mistake, and the
      // rail (which carries the Meetings entry) is not in this tree at all.
      await expect(visitor.getByRole('button', { name: 'Start voice call' })).toHaveCount(0);
      await expect(visitor.getByRole('button', { name: 'Start video call' })).toHaveCount(0);
      await expect(visitor.getByRole('button', { name: 'Join call' })).toHaveCount(0);
      await expect(visitor.getByRole('button', { name: 'Meetings' })).toHaveCount(0);
      await expect(visitor.locator('aside')).toHaveCount(0);
      // The only attach control offers files — never a call or a meeting.
      await expect(visitor.getByText(/Start a meeting|Join meeting|เริ่มประชุม/)).toHaveCount(0);

      // The agent's earlier reply is already in the transcript, and it renders
      // with the EXTERNAL label assembled from write-time snapshots:
      // "provider name (admin username)" — chat-core `agentExternalName`, one
      // definition shared by the server and both clients so it cannot drift.
      const externalName = `${PROVIDER} (${AGENT_USERNAME})`;
      await expect(visitor.getByText(externalName).first()).toBeVisible({ timeout: 30_000 });
      await shot(visitor, '02-agent-label');

      // ---- the visitor sends (API-212) -----------------------------------
      const said = `pw-visitor-said ${stamp}`;
      await visitor.getByLabel('Write a reply...').fill(said);
      await visitor.getByRole('button', { name: 'Send' }).click();
      await expect(visitor.getByText(said)).toBeVisible({ timeout: 30_000 });
      // Their own row is labelled "You" — the customer has no username and is
      // never given one (FR-PCHAT-014 runs one way only). Scoped to the message
      // author element: a bare getByText('You') would also match the
      // "You are chatting with …" heading and pass for the wrong reason.
      await expect(
        visitor.locator('.bc-pchat-msg[data-mine="true"] .bc-pchat-author').first(),
      ).toContainText('You', { timeout: 15_000 });
      await shot(visitor, '03-visitor-sent');

      // ---- what the customer must NEVER see (FR-PCHAT-007) ---------------
      const body = await visitor.locator('body').innerText();
      // The raw internal status vocabulary, including the `problem` triage
      // flag, is projected to open/closed before it leaves the server
      // (MANDATORY graft 1). None of the four internal labels may appear.
      expect(body).not.toContain('In progress');
      expect(body).not.toContain('Problem');
      // No internal identity: no workspace id, no room ULID, no `meta`.
      expect(body).not.toContain(partner.roomId);
      expect(body).not.toContain('playwright-regression');
      // The agent's bare username never appears on its own — only ever inside
      // the assembled "provider (username)" label.
      expect(body.split(externalName).join('')).not.toContain(AGENT_USERNAME);

      // ---- the agent sees it arrive --------------------------------------
      // Round-trips the other direction through the same room: proof the two
      // channels (private-public-chat.{rid} / -staff.{rid}) are wired to one
      // conversation, and that the visitor's row reaches the staff surface.
      const page = agent as Page;
      await page.goto(`/public-chat/${partner.roomId}`);
      await expect(page.getByText(said)).toBeVisible({ timeout: 30_000 });
      // Staff-side the customer shows under their own name, never "You".
      await expect(page.getByText(CUSTOMER).first()).toBeVisible();
      await shot(page, '04-agent-sees-visitor-message');
    } finally {
      await visitorContext.close();
    }
  });
});
