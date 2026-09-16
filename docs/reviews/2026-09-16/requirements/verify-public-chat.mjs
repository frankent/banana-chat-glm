/**
 * FR-PCHAT-001..034 · API-200..228 · EVT-080..085 — production verification of
 * the Public Chat bounded context, all three tiers, against the live site.
 *
 * Shape copied from verify-meetings.mjs: plain ESM .mjs run with `node`,
 * @playwright/test resolved through apps/web/package.json, chromium channel
 * 'chrome', production gated on an env var, and the php() helper running on the
 * prod container over the SHARED SSH ControlMaster socket at
 * /tmp/banana-sept16-ssh.
 *
 *   PCHAT_QA_PRODUCTION=1 node docs/reviews/2026-09-16/requirements/verify-public-chat.mjs
 *
 * ==== PRODUCTION SAFETY — read before editing ==============================
 * Production holds REAL rooms, messages, users and one real workspace. Every
 * write in this script is scoped to a throwaway workspace created here with a
 * unique time-based prefix, or to a row id this script itself created. There is
 * no unscoped UPDATE or DELETE anywhere.
 *
 * THE FEATURE FLAG IS THE SINGLE MOST IMPORTANT LINE IN THIS FILE. Public Chat
 * ships dark (DEC-071) and production currently has publicchat.enabled = false.
 * The original RAW app_settings row is captured BEFORE anything else, the
 * restore is the FIRST step of a finally block that runs even when an assertion
 * throws, and the restore is verified by reading the value back. If the row was
 * absent originally it is DELETED again rather than written as `false`, so the
 * settings table ends byte-identical to how it started. A failed restore is
 * itself a test failure and exits non-zero.
 *
 * Baseline counts AND id lists for rooms / messages / users / workspaces
 * OUTSIDE the fixture workspace are captured at the start and re-read at the
 * end; every baseline id must still be present (subset, not equality — real
 * users may legitimately write during the run).
 *
 * The API key issued here is REVOKED and then deleted in cleanup.
 *
 * Login throttle is 5/min/IP and 10/15min/username: this script performs
 * exactly ONE login and reuses the context.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
const root = new URL("../../../../", import.meta.url).pathname;
const require = createRequire(root + "apps/web/package.json");
const { chromium, expect } = require("@playwright/test");
const prod = process.env.PCHAT_QA_PRODUCTION === "1";
const base = prod ? "https://chat.gamecoms.net" : "http://127.0.0.1:5173";
const api = prod ? base : "http://localhost:18000";
function php(code) {
  return execFileSync(
    prod ? "ssh" : "docker",
    prod
      ? [
          "-S",
          "/tmp/banana-sept16-ssh",
          "root@165.22.63.119",
          "cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php",
        ]
      : ["exec", "-i", "-w", "/app", "banana-chat-call-review", "php"],
    {
      input: `<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,
      encoding: "utf8",
    },
  );
}
const json = (code) => JSON.parse(php(code));

const prefix = "pchatqa" + Date.now();
const password = randomBytes(20).toString("hex");
// NO fixture string may contain 'problem', 'in_progress' or 'มีปัญหา': check 8
// asserts the visitor surface is free of those tokens and would otherwise trip
// on our own test data.
const customerName = "QA Customer " + prefix;
const providerName = "QA Support Desk " + prefix;
const externalRef = "ticket-" + prefix;
const visitorBody = "Hello support, my order has not arrived. " + prefix;
const agentBody = "Thanks for reaching out, we are looking into it now. " + prefix;
const FORBIDDEN = ["problem", "in_progress", "มีปัญหา"];

const results = [];
const errors = [];
const shots = [];
const pages = [];
const contexts = [];
const evidence = {};
const pass = (test, extra = {}) => results.push({ test, status: "passed", ...extra });
const shot = async (page, name) => {
  const path = new URL((prod ? "production-" : "") + name + ".png", import.meta.url).pathname;
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
};

let browser = null;
let fixture = null;
let apiKey = null;
let originalFlag = null; // {value, updated_by, updated_at} | null  (RAW row, null = row absent)
let originalEnabled = false;
let flagChanged = false;
let room = null; // {id, code, url}
let agentToken = "";
let baseline = null;
let flagRestored = false;

/**
 * Synchronous, idempotent restore of publicchat.enabled.
 *
 * `php()` is execFileSync, so this is safe to call from a signal handler and
 * from process 'exit', where nothing async can be awaited. THE `finally` BLOCK
 * BELOW IS NOT ENOUGH ON ITS OWN: it does not run on SIGINT / SIGTERM / SIGHUP,
 * and it does not run when the process dies on an unhandled rejection (a
 * Playwright event handler rejecting, say). A customer-facing surface left
 * switched on is the worst outcome this script can produce, so the restore is
 * wired to those paths as well as to the happy one.
 *
 * Gated on `flagChanged`, which is now assigned on the statement IMMEDIATELY
 * before the enabling php() call with no await in between — so there is no
 * interleaving in which the enable lands on the server and this guard is still
 * false, which is the only reason to consider making it unconditional. Keeping
 * the gate means an early abort (a failed baseline assertion, ssh dying during
 * fixture creation) never writes to a real app_settings row at all: the raw
 * value bytes are asserted on the way back, but `updated_at` is captured with
 * toDateTimeString() in app time and rewritten into a timestamptz column, so
 * even a "no-op" writeback could shift it by the timezone offset. The row is
 * touched only when this script actually toggled it.
 *
 * The guard is set only AFTER a successful restore, so a transient ssh failure
 * here is retried by the next caller (finally, then 'exit') rather than latched.
 */
function restoreFlagSync() {
  if (flagRestored || originalFlag === null || !flagChanged) return;
  if (originalFlag.row === null) {
    // The row did not exist: delete it again rather than writing `false`, so
    // the settings table ends byte-identical to how it started.
    php(
      `App\\Models\\AppSetting::query()->where('key','publicchat.enabled')->delete();` +
        `app(App\\Services\\SettingsService::class)->flush();`,
    );
  } else {
    // originalFlag.row.value is the RAW jsonb text as it sits in the column
    // (`false`, not `"false"`), read with getRawOriginal so no cast touched it.
    // JSON.stringify once turns it into the PHP string literal for exactly
    // those bytes — stringifying twice would store the JSON STRING "false" in
    // place of the JSON BOOLEAN false, which is truthy.
    const updatedBy = originalFlag.row.updated_by === null ? "null" : `'${originalFlag.row.updated_by}'`;
    const updatedAt = originalFlag.row.updated_at === null ? "null" : `'${originalFlag.row.updated_at}'`;
    php(
      `DB::table('app_settings')->updateOrInsert(['key'=>'publicchat.enabled'],` +
        `['value'=>${JSON.stringify(String(originalFlag.row.value))},'updated_by'=>${updatedBy},'updated_at'=>${updatedAt}]);` +
        `app(App\\Services\\SettingsService::class)->flush();`,
    );
  }
  flagRestored = true;
}

// Registered HERE, before chromium.launch(), on purpose: Playwright installs
// its own SIGINT listener when the browser launches and that listener exits the
// process after an async close. Node dispatches signal listeners in
// registration order, so ours has to be in place first. 'exit' additionally
// covers process.exit(), uncaught exceptions and unhandled rejections — none of
// which unwind the try/finally below. A Ctrl-C may orphan a Chrome process;
// that is a trivial price next to leaving the kill switch open.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      restoreFlagSync();
    } catch (e) {
      console.error(`FLAG RESTORE FAILED on ${signal}: ${e.message}`);
    }
    process.exit(130);
  });
}
process.on("exit", () => {
  try {
    restoreFlagSync();
  } catch (e) {
    console.error(`FLAG RESTORE FAILED on exit: ${e.message}`);
  }
});

/**
 * The baseline snapshot, as ONE string used by both the opening and the closing
 * capture so the two can never drift apart.
 *
 * DELIBERATELY plain DB::table(), with NO whereNull('deleted_at'). `rooms` and
 * `messages` both carry a deleted_at column, but filtering on it here would be
 * a FLAKE, not a safeguard: a real user soft-deleting one of their own messages
 * mid-run would drop an id from the list and fail this check, and a false
 * failure costs a whole flag-toggle cycle on production to re-run. Soft deletes
 * are caught where they can actually happen — the only write-shaped requests
 * this script aims at rows it did not create are the isolation probes at
 * `realRoomId` and `realMessageId`, and those two ids get direct
 * `deleted_at IS NULL` assertions in check 9. This list's job is hard deletes,
 * which it still catches for every row in every table.
 */
const SNAPSHOT_PHP =
  `echo json_encode([` +
  `'rooms'=>['count'=>DB::table('rooms')->count(),'ids'=>DB::table('rooms')->pluck('id')],` +
  `'messages'=>['count'=>DB::table('messages')->count(),'ids'=>DB::table('messages')->pluck('id')],` +
  `'users'=>['count'=>DB::table('users')->count(),'ids'=>DB::table('users')->pluck('id')],` +
  `'workspaces'=>['count'=>DB::table('workspaces')->count(),'ids'=>DB::table('workspaces')->pluck('id')],` +
  `'public_chat_rooms'=>['count'=>DB::table('public_chat_rooms')->count(),'ids'=>DB::table('public_chat_rooms')->pluck('id')],` +
  `'public_chat_api_keys'=>['count'=>DB::table('public_chat_api_keys')->count(),'ids'=>DB::table('public_chat_api_keys')->pluck('id')],` +
  `]);`;

// --------------------------------------------------------------- HMAC (Tier 1)
// VerifyPublicChatSignature: canonical string is exactly 6 "\n"-joined lines —
// v1 / METHOD / path INCLUDING the /api/v1 prefix with its leading slash and NO
// query string / timestamp / nonce / lowercase hex sha256 of the RAW body bytes
// (sha256("") when there is no body). The signature header is "v1=" + hex HMAC.
// We sign the exact string we put on the wire, never a re-serialised object.
function canonical(method, path, timestamp, nonce, rawBody) {
  return [
    "v1",
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    createHash("sha256").update(rawBody, "utf8").digest("hex"),
  ].join("\n");
}

function freshNonce() {
  return randomBytes(16).toString("hex"); // 32 chars of [a-f0-9] — inside [A-Za-z0-9_-]{16,64}
}

/**
 * @param {object} o
 *   body        object|null   — JSON body; null sends no body
 *   signBody    string|undefined — sign THESE bytes instead of what we send (tamper test)
 *   timestamp   number|undefined — override the unix seconds (skew test)
 *   nonce       string|undefined — override (replay test)
 *   keyId/secret string|undefined — override (unknown key test)
 *   omit        string[]      — header names to leave off entirely
 */
async function signed(method, path, o = {}) {
  const raw = o.body === undefined || o.body === null ? "" : JSON.stringify(o.body);
  const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? freshNonce();
  const keyId = o.keyId ?? apiKey.key_id;
  const secret = o.secret ?? apiKey.secret;
  const signature =
    "v1=" +
    createHmac("sha256", secret)
      .update(canonical(method, path, timestamp, nonce, o.signBody ?? raw), "utf8")
      .digest("hex");

  const headers = { Accept: "application/json" };
  if (raw !== "") headers["Content-Type"] = "application/json";
  const all = {
    "X-PChat-Key": keyId,
    "X-PChat-Timestamp": timestamp,
    "X-PChat-Nonce": nonce,
    "X-PChat-Signature": signature,
  };
  for (const [name, value] of Object.entries(all)) {
    if (!(o.omit ?? []).includes(name)) headers[name] = value;
  }

  // A bare fetch has NO timeout. A hung connection here would stall the run
  // with the kill switch still open, waiting on an operator to notice.
  const res = await fetch(api + path, {
    method,
    headers,
    body: raw === "" ? undefined : raw,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed, text, nonce };
}

/** §7 envelope: {error:{code,message,details,request_id}}. */
function expectApiError(res, status, code) {
  expect(
    { status: res.status, code: res.body?.error?.code },
    `expected ${status} ${code}, got ${res.status} ${res.text.slice(0, 300)}`,
  ).toEqual({ status, code });
}

/** Tier-3 call as the logged-in agent. `ctx` is a Playwright APIRequestContext. */
async function agentApi(ctx, method, path, data) {
  const res = await ctx.fetch(api + path, {
    method,
    headers: {
      Authorization: "Bearer " + agentToken,
      "X-Workspace-Id": fixture.slug,
      Accept: "application/json",
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { data }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status(), body, text };
}

async function context(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  contexts.push(ctx);
  const page = await ctx.newPage();
  pages.push(page);
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  return page;
}

try {
  // ===================================================================== 0
  // The flag, FIRST, as the RAW row. `null` means the row does not exist and
  // the effective value comes from SettingsService::DEFAULTS — restoring that
  // state means DELETING the row again, not writing `false` into it.
  originalFlag = json(
    `$r=App\\Models\\AppSetting::query()->where('key','publicchat.enabled')->first();` +
      `echo json_encode(['row'=>$r===null?null:['value'=>$r->getRawOriginal('value'),'updated_by'=>$r->updated_by,'updated_at'=>optional($r->updated_at)->toDateTimeString()],` +
      `'effective'=>(bool) app(App\\Services\\SettingsService::class)->get('publicchat.enabled', false)]);`,
  );
  originalEnabled = originalFlag.effective === true;
  evidence.original_flag = originalFlag;

  // Baseline: counts AND id lists for everything that is NOT ours. The fixture
  // does not exist yet, so this is simply "all of production".
  baseline = json(SNAPSHOT_PHP);
  evidence.baseline_counts = Object.fromEntries(
    Object.entries(baseline).map(([k, v]) => [k, v.count]),
  );
  expect(baseline.rooms.count).toBeGreaterThan(0);
  pass("PROD-SAFETY baseline captured for rooms/messages/users/workspaces outside the fixture", {
    counts: evidence.baseline_counts,
  });

  // A real production room id — used ONLY as a read-only negative probe against
  // the public-chat endpoints in check 9. Never written to, never modified.
  const realRoomId = baseline.rooms.ids[0];

  // ===================================================================== 1
  // Throwaway workspace + ONE member (one login; the throttle is 5/min/IP).
  fixture = json(
    `$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Public Chat QA','status'=>'active']);` +
      `$u=App\\Models\\User::create(['username'=>'${prefix}a','display_name'=>'Dana Agent','password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);` +
      `$w->members()->attach($u->id,['role'=>'member']);` +
      `echo json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'user'=>$u->id,'username'=>$u->username,'display_name'=>$u->display_name]);`,
  );
  evidence.fixture = fixture;

  // ===================================================================== 2
  // FR-PCHAT-030 — issue an API key. The Filament issuance action is a
  // system-admin act behind the `admin` guard and this script holds no admin
  // credential, so it goes through the same service layer that the Filament
  // header action calls (PublicChatApiKeyService::issue), which is the code
  // path under test.
  apiKey = json(
    `$r=app(App\\Domain\\PublicChat\\PublicChatApiKeyService::class)->issue('${fixture.workspace}','QA ${prefix}',null);` +
      `$row=DB::table('public_chat_api_keys')->where('id',$r['key']->id)->first();` +
      `echo json_encode(['id'=>$r['key']->id,'key_id'=>$r['key_id'],'secret'=>$r['secret'],` +
      `'serialized'=>$r['key']->toArray(),` +
      `'stored_ciphertext'=>$row->secret_ciphertext,'stored_last4'=>$row->secret_last4,'workspace_id'=>$row->workspace_id]);`,
  );
  expect(apiKey.key_id).toMatch(/^pck_[0-9a-f]{28}$/);
  expect(apiKey.secret).toMatch(/^pcs_[0-9a-f]{64}$/);
  expect(apiKey.workspace_id).toBe(fixture.workspace);
  // The plaintext is returned EXACTLY once, by issue(). Reading the row back
  // must give ciphertext + last4 and never the plaintext (DEC-062, $hidden).
  expect(Object.keys(apiKey.serialized)).not.toContain("secret_ciphertext");
  expect(JSON.stringify(apiKey.serialized)).not.toContain(apiKey.secret);
  expect(apiKey.stored_last4).toBe(apiKey.secret.slice(-4));
  expect(apiKey.stored_ciphertext).not.toBe(apiKey.secret);
  expect(apiKey.stored_ciphertext).not.toContain(apiKey.secret);
  expect(apiKey.stored_ciphertext).not.toContain(apiKey.secret.slice(4));
  // The audit row records the PUBLIC key_id and must never carry the secret.
  const auditIssued = json(
    `$rows=DB::table('audit_logs')->where('action','public_chat.api_key_issued')->where('target_id','${apiKey.id}')->get();` +
      `echo json_encode(['count'=>$rows->count(),'blob'=>$rows->toJson()]);`,
  );
  expect(auditIssued.count).toBe(1);
  expect(auditIssued.blob).toContain(apiKey.key_id);
  expect(auditIssued.blob).not.toContain(apiKey.secret);
  pass("FR-PCHAT-030 API key issued: plaintext returned once, row stores ciphertext + last4 only", {
    key_id: apiKey.key_id,
    stored_last4: apiKey.stored_last4,
  });

  // ===================================================================== 3
  // CHECK 1 — the kill switch, in the state production is in RIGHT NOW.
  // A correctly signed partner create must be rejected 503 PCHAT_DISABLED. The
  // 503 (rather than a 401) is also the proof that the signature verified: the
  // gate runs LAST, in the controller, after all five verification steps.
  if (originalEnabled) {
    results.push({
      test: "FR-PCHAT-034 kill switch gates a signed partner create (503 PCHAT_DISABLED)",
      status: "skipped",
      reason: "publicchat.enabled was already true in production; not toggled off to test this",
    });
  } else {
    const offCreate = await signed("POST", "/api/v1/partner/public-chat/rooms", {
      body: { customer_name: customerName, provider_name: providerName },
    });
    expectApiError(offCreate, 503, "PCHAT_DISABLED");
    evidence.feature_off_create = { status: offCreate.status, code: offCreate.body?.error?.code };
    pass("FR-PCHAT-034 kill switch gates a correctly signed partner create with 503 PCHAT_DISABLED");
  }

  // ===================================================================== 4
  // Enable the feature. EVERYTHING after this point is inside the window the
  // finally block exists to close.
  // Set BEFORE the call, never after: the enable can land on the server and the
  // ssh still report a non-zero exit, and a `flagChanged` that was only set on
  // a clean return would then skip the restore and leave the feature ON.
  // (restoreFlagSync() is unconditional anyway; this keeps the evidence honest.)
  flagChanged = true;
  php(`app(App\\Services\\SettingsService::class)->set('publicchat.enabled', true);`);
  const enabledNow = json(
    `echo json_encode(['enabled'=>(bool) app(App\\Services\\SettingsService::class)->get('publicchat.enabled', false)]);`,
  );
  expect(enabledNow.enabled).toBe(true);

  // ===================================================================== 5
  // CHECK 4 — API-200 create + external_ref idempotency.
  const created = await signed("POST", "/api/v1/partner/public-chat/rooms", {
    body: {
      customer_name: customerName,
      provider_name: providerName,
      external_ref: externalRef,
      locale: "th",
      meta: { source: "verify-public-chat.mjs", run: prefix },
    },
  });
  expect(
    { status: created.status, text: created.text.slice(0, 300) },
    "signed create must be accepted once the feature is on",
  ).toMatchObject({ status: 201 });
  expect(created.body.url).toMatch(/^https?:\/\/[^/]+\/support\/[a-f0-9]{64}$/);
  expect(created.body.room.code).toMatch(/^[a-f0-9]{64}$/);
  expect(created.body.room.status).toBe("new");
  expect(created.body.room.customer_name).toBe(customerName);
  expect(created.body.room.provider_name).toBe(providerName);
  expect(created.body.room.assigned_display_name).toBeNull();
  room = { id: created.body.room.id, code: created.body.room.code, url: created.body.url };
  expect(created.body.url.endsWith("/support/" + room.code)).toBe(true);
  // The room must belong to OUR workspace and nowhere else.
  const owned = json(
    `$r=App\\Models\\PublicChatRoom::withoutGlobalScopes()->whereKey('${room.id}')->firstOrFail();` +
      `echo json_encode(['workspace_id'=>$r->workspace_id,'api_key_id'=>$r->api_key_id]);`,
  );
  expect(owned.workspace_id).toBe(fixture.workspace);
  expect(owned.api_key_id).toBe(apiKey.id);

  // Idempotent replay: SAME external_ref, FRESH nonce (a reused nonce would be
  // a 409 replay, which is a different mechanism). 200, same id, same code.
  const replayed = await signed("POST", "/api/v1/partner/public-chat/rooms", {
    body: {
      customer_name: customerName + " (retry)",
      provider_name: providerName,
      external_ref: externalRef,
      locale: "th",
    },
  });
  expect(replayed.status).toBe(200);
  expect(replayed.body.room.id).toBe(room.id);
  expect(replayed.body.room.code).toBe(room.code);
  expect(replayed.body.url).toBe(room.url);
  const roomCount = json(
    `echo json_encode(['n'=>App\\Models\\PublicChatRoom::withoutGlobalScopes()->where('workspace_id','${fixture.workspace}')->count()]);`,
  );
  expect(roomCount.n).toBe(1);
  evidence.room = { id: room.id, url: room.url };
  pass("API-200 create returns a /support/<64-hex> link and replaying external_ref is idempotent", {
    room_id: room.id,
    replay_status: replayed.status,
  });

  // ===================================================================== 6
  // CHECK 3 — HMAC, every failure mode with its documented code.
  const hmac = {};

  // accepted (a read, so it is side-effect free and safe to repeat)
  const showPath = "/api/v1/partner/public-chat/rooms/" + room.id;
  const okShow = await signed("GET", showPath);
  expect(okShow.status).toBe(200);
  expect(okShow.body.room.code).toBe(room.code);
  hmac.accepted = okShow.status;

  // missing headers -> 401 API_KEY_INVALID (each header omitted in turn)
  for (const header of ["X-PChat-Key", "X-PChat-Timestamp", "X-PChat-Nonce", "X-PChat-Signature"]) {
    const res = await signed("GET", showPath, { omit: [header] });
    expectApiError(res, 401, "API_KEY_INVALID");
    hmac["missing:" + header] = res.status;
  }

  // timestamp skew beyond the ±300s window -> 401 API_TIMESTAMP_SKEW
  for (const offset of [-400, 400]) {
    const res = await signed("GET", showPath, {
      timestamp: Math.floor(Date.now() / 1000) + offset,
    });
    expectApiError(res, 401, "API_TIMESTAMP_SKEW");
    hmac["skew:" + offset] = res.status;
  }

  // unknown key -> 401 API_KEY_INVALID (well-formed, simply not ours)
  const unknown = await signed("GET", showPath, {
    keyId: "pck_" + randomBytes(14).toString("hex"),
  });
  expectApiError(unknown, 401, "API_KEY_INVALID");
  hmac.unknown_key = unknown.status;

  // tampered body -> 401 API_SIGNATURE_INVALID. Sign one set of bytes, send
  // another; the digest line of the canonical string no longer matches.
  const honest = JSON.stringify({ customer_name: customerName, provider_name: providerName });
  const tamperNonce = freshNonce();
  const tampered = await signed("POST", "/api/v1/partner/public-chat/rooms", {
    body: { customer_name: customerName + " TAMPERED", provider_name: providerName },
    signBody: honest,
    nonce: tamperNonce,
  });
  expectApiError(tampered, 401, "API_SIGNATURE_INVALID");
  hmac.tampered_body = tampered.status;

  // TC-PCHAT-050 — a BAD SIGNATURE MUST NOT BURN THE NONCE. Step 5 runs after
  // step 4 precisely so an observer cannot pre-consume a partner's nonces with
  // unsigned garbage. The same nonce must still be accepted on a correct call.
  const reusedAfterBadSig = await signed("GET", showPath, { nonce: tamperNonce });
  expect(reusedAfterBadSig.status).toBe(200);
  hmac.nonce_survives_bad_signature = reusedAfterBadSig.status;

  // replayed nonce -> 409 API_NONCE_REPLAYED (the second GET reuses the first's)
  const replayNonce = freshNonce();
  const firstUse = await signed("GET", showPath, { nonce: replayNonce });
  expect(firstUse.status).toBe(200);
  const secondUse = await signed("GET", showPath, { nonce: replayNonce });
  expectApiError(secondUse, 409, "API_NONCE_REPLAYED");
  hmac.replayed_nonce = secondUse.status;

  evidence.hmac = hmac;
  pass(
    "FR-PCHAT-031 HMAC accepts a correct signature and rejects missing headers / skew / unknown key / tampered body / replayed nonce with the documented codes",
    hmac,
  );

  // ===================================================================== 7
  browser = await chromium.launch({ channel: "chrome" });

  // CHECK 5 — VISITOR, real browser, NO login. The bearer must never exist in
  // this context: FR-PCHAT-013 turns any signed-in viewer into a 403
  // PCHAT_SIGNED_IN on write, so a leaked token would silently change the test.
  const visitor = await context();
  const visitorHeaders = [];
  visitor.on("response", (res) => {
    try {
      visitorHeaders.push({ url: res.url(), headers: res.headers() });
    } catch {
      /* response already discarded */
    }
  });
  await visitor.goto(base + "/support/" + room.code);
  await expect(visitor.locator(".bc-pchat-visitor-card")).toBeVisible();
  await expect(visitor.locator(".bc-pchat-visitor-head h1")).toContainText(providerName);
  await expect(visitor.locator(".bc-pchat-visitor-head .bc-caption")).toHaveText(customerName);

  // No call, no meeting — the page mounts OUTSIDE CallProvider (App.tsx), so
  // the assertion is structural: none of the call surfaces can exist at all.
  for (const selector of [
    "[data-lk-source]",
    ".bc-call-stage",
    ".bc-call-controls",
    ".bc-call-focus",
    ".bc-call-count",
    "video",
  ]) {
    await expect(visitor.locator(selector), `visitor page must not render ${selector}`).toHaveCount(0);
  }
  for (const name of [/call/i, /meeting/i, /video/i, /โทร/, /ประชุม/, /join/i]) {
    await expect(visitor.getByRole("button", { name }), `no ${name} control on the visitor page`).toHaveCount(0);
    await expect(visitor.getByRole("link", { name }), `no ${name} link on the visitor page`).toHaveCount(0);
  }

  // Send a text message as the customer. The room locale is 'th', so the
  // composer is addressed by CSS rather than by a translated label.
  const composer = visitor.locator(".bc-pchat-composer textarea");
  await expect(composer).toBeVisible();
  await composer.fill(visitorBody);
  await visitor.locator(".bc-pchat-composer .bc-pchat-send").click();
  await expect(visitor.locator(".bc-pchat-msg.kind-visitor .bc-pchat-body")).toHaveText(visitorBody);
  await shot(visitor, "public-chat-visitor");
  const visitorStored = json(
    `$m=App\\Models\\PublicChatMessage::withoutGlobalScopes()->where('room_id','${room.id}')->where('sender_kind','visitor')->get();` +
      `echo json_encode(['n'=>$m->count(),'sender_kind'=>$m->pluck('sender_kind'),'sender_user_id'=>$m->pluck('sender_user_id'),'workspace_id'=>$m->pluck('workspace_id')]);`,
  );
  expect(visitorStored.n).toBe(1);
  expect(visitorStored.sender_user_id).toEqual([null]);
  expect(visitorStored.workspace_id).toEqual([fixture.workspace]);
  pass(
    "FR-PCHAT-007 visitor opens the link with no login, sees customer + provider names, sends a message, and no call/meeting control exists anywhere on the page",
  );

  // ===================================================================== 8
  // CHECK 6 — AGENT. ONE login for the whole run.
  const agent = await context();
  agent.on("response", async (res) => {
    try {
      if (res.url().endsWith("/auth/login") && res.ok()) agentToken = (await res.json()).access_token;
    } catch {
      /* body already consumed or context closing */
    }
  });
  await agent.goto(base + "/login");
  await agent.getByLabel("Username").fill(fixture.username);
  await agent.getByLabel("Password").fill(password);
  await agent.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(agent.locator("aside")).toBeVisible();
  await expect.poll(() => agentToken).not.toBe("");

  // FR-PCHAT-003 — the rail entry exists.
  const rail = agent.getByRole("button", { name: "Public Chat", exact: true });
  await expect(rail).toHaveCount(1);
  await rail.click();
  await expect(agent).toHaveURL(new RegExp("/public-chat$"));

  const row = agent.locator(".bc-pchat-list li", { hasText: customerName });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".bc-pchat-pill")).toHaveText("New");
  await expect(row.locator(".bc-pchat-unassigned")).toHaveText("Unassigned");

  // Filters, BEFORE the claim. Server-side by construction: the filter values
  // are part of the react-query key and are serialised onto API-220.
  const statusSegment = agent.getByRole("group", { name: "Filter status" });
  const assigneeSelect = agent.getByLabel("Assigned to");
  await statusSegment.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row).toHaveCount(0);
  await statusSegment.getByRole("button", { name: "New", exact: true }).click();
  await expect(row).toHaveCount(1);
  await statusSegment.getByRole("button", { name: "All", exact: true }).click();
  await assigneeSelect.selectOption("me");
  await expect(row).toHaveCount(0);
  await assigneeSelect.selectOption("none");
  await expect(row).toHaveCount(1);
  await assigneeSelect.selectOption("all");
  await expect(row).toHaveCount(1);

  // The same two filters straight against API-220, so "server-side" is proved
  // rather than inferred from the rendered list.
  const queueDone = await agentApi(agent.request, "GET", "/api/v1/public-chat/rooms?status=done");
  expect(queueDone.status).toBe(200);
  expect(queueDone.body.rooms.map((r) => r.id)).not.toContain(room.id);
  const queueUnassigned = await agentApi(agent.request, "GET", "/api/v1/public-chat/rooms?assigned=none");
  expect(queueUnassigned.status).toBe(200);
  expect(queueUnassigned.body.rooms.map((r) => r.id)).toContain(room.id);
  const queueMine = await agentApi(agent.request, "GET", "/api/v1/public-chat/rooms?assigned=me");
  expect(queueMine.status).toBe(200);
  expect(queueMine.body.rooms.map((r) => r.id)).not.toContain(room.id);
  pass(
    "FR-PCHAT-004/005 the Public Chat rail entry exists, the room lists as status 'new' with no assignee, and status + assignee filters run server-side (API-220)",
  );

  // AUTO-CLAIM — FR-PCHAT-009. Replying claims the room inside the writer's
  // lockForUpdate transaction: assignee becomes this user and 'new' advances to
  // 'in progress'.
  await row.locator(".bc-pchat-row").click();
  await expect(agent).toHaveURL(new RegExp("/public-chat/" + room.id + "$"));
  await expect(agent.locator(".bc-pchat-room-who h2")).toHaveText(customerName);
  await expect(agent.locator(".bc-pchat-room-head .bc-pchat-pill")).toHaveText("New");
  await expect(agent.getByLabel("Assigned to")).toHaveValue("");

  const agentComposer = agent.locator(".bc-pchat-composer textarea");
  await agentComposer.fill(agentBody);
  await agent.locator(".bc-pchat-composer .bc-pchat-send").click();
  await expect(agent.locator(".bc-pchat-msg.kind-agent .bc-pchat-body")).toHaveText(agentBody);

  const assertClaimed = async () => {
    await expect(agent.locator(".bc-pchat-room-head .bc-pchat-pill")).toHaveText("In progress");
    await expect(agent.getByLabel("Status")).toHaveValue("in_progress");
    await expect(agent.getByLabel("Assigned to")).toHaveValue(fixture.user);
    await expect(agent.locator(".bc-pchat-room-who p")).toContainText(
      "Claimed by " + fixture.display_name,
    );
  };
  await assertClaimed();
  // …and it is durable, not just optimistic client state.
  await agent.reload();
  await expect(agent.locator(".bc-pchat-room-who h2")).toHaveText(customerName);
  await assertClaimed();

  const claimedRow = json(
    `$r=App\\Models\\PublicChatRoom::withoutGlobalScopes()->whereKey('${room.id}')->firstOrFail();` +
      `echo json_encode(['status'=>$r->status->value,'assigned_to'=>$r->assigned_to,'claimed_at'=>$r->claimed_at?->toIso8601String()]);`,
  );
  expect(claimedRow.status).toBe("in_progress");
  expect(claimedRow.assigned_to).toBe(fixture.user);
  expect(claimedRow.claimed_at).not.toBeNull();

  // Back to the queue for the evidence screenshot + the post-claim filters.
  await agent.goto(base + "/public-chat");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".bc-pchat-pill")).toHaveText("In progress");
  await expect(row.locator(".bc-pchat-row-agent")).toContainText(fixture.display_name);
  await shot(agent, "public-chat-queue");
  await agent.getByLabel("Assigned to").selectOption("me");
  await expect(row).toHaveCount(1);
  await agent.getByLabel("Assigned to").selectOption("none");
  await expect(row).toHaveCount(0);
  await agent.getByLabel("Assigned to").selectOption("all");
  pass(
    "FR-PCHAT-009 an agent reply auto-claims the room (assignee set, status 'new' -> 'in progress'), and the claim survives a reload",
    // NB: key must not be `status` — pass() spreads this into the result row and
    // would overwrite the row's own pass/fail status field.
    { assigned_to: claimedRow.assigned_to, room_status: claimedRow.status },
  );

  // ===================================================================== 9
  // CHECK 7 — the agent renders externally as `provider name (admin username)`
  // from write-time snapshots, never a join on `users`.
  const expectedExternal = providerName + " (" + fixture.username + ")";
  // A hidden tab has its timers throttled to roughly one tick a minute, which
  // would starve the 5s ?after_seq= polling fallback if the socket did not
  // connect. Front the page before waiting on the agent's message.
  await visitor.bringToFront();
  const authorNode = visitor.locator(".bc-pchat-msg.kind-agent .bc-pchat-author");
  await expect(authorNode).toHaveCount(1, { timeout: 30000 });
  const renderedAuthor = await authorNode.evaluate((el) => el.firstChild?.nodeValue ?? "");
  expect(renderedAuthor).toBe(expectedExternal);
  const visitorMessages = await visitor.request.get(api + "/api/v1/public-chat/" + room.code + "/messages");
  expect(visitorMessages.status()).toBe(200);
  const visitorMessagesBody = await visitorMessages.json();
  const agentRow = visitorMessagesBody.messages.find((m) => m.sender_kind === "agent");
  expect(agentRow.display_name).toBe(expectedExternal);
  // The snapshots are what produce it — no user ULID or display_name crosses.
  const wire = JSON.stringify(visitorMessagesBody);
  expect(wire).not.toContain(fixture.user);
  expect(wire).not.toContain(fixture.display_name);
  evidence.external_display_name = renderedAuthor;
  pass("FR-PCHAT-014 the agent reply renders to the visitor as `provider name (admin username)`", {
    rendered: renderedAuthor,
  });

  // ==================================================================== 10
  // CHECK 8 — `problem` is an internal triage flag. It must not reach the
  // visitor in the page text, in API-210 or in API-211 — and under DEC-074 the
  // zero-delta status_changed row must not even EXIST for them, because the row
  // itself would leak the timing the projection exists to hide.
  const visibleBefore = visitorMessagesBody.messages.map((m) => m.id);

  await agent.goto(base + "/public-chat/" + room.id);
  await agent.getByLabel("Status").selectOption("problem");
  await expect(agent.locator(".bc-pchat-room-head .bc-pchat-pill")).toHaveText("Problem");
  const problemRow = json(
    `echo json_encode(['status'=>App\\Models\\PublicChatRoom::withoutGlobalScopes()->whereKey('${room.id}')->value('status')]);`,
  );
  expect(problemRow.status).toBe("problem");

  const scanVisitorSurface = async (label) => {
    await visitor.reload();
    // `.bc-pchat-visitor-card` is ALSO the class on the early-return card the
    // page renders while loading or on a 410, so waiting on it alone would let
    // this negation pass vacuously against a half-rendered page. Wait for the
    // real transcript — the provider heading AND the agent's reply — before
    // scraping the text.
    await expect(visitor.locator(".bc-pchat-visitor-head h1")).toContainText(providerName);
    await expect(visitor.locator(".bc-pchat-msg.kind-agent")).toHaveCount(1);
    const text = await visitor.evaluate(() => document.body.innerText);
    const showRes = await visitor.request.get(api + "/api/v1/public-chat/" + room.code);
    const msgRes = await visitor.request.get(api + "/api/v1/public-chat/" + room.code + "/messages");
    const showText = await showRes.text();
    const msgText = await msgRes.text();
    for (const token of FORBIDDEN) {
      expect(text, `${label}: page text must not contain "${token}"`).not.toContain(token);
      expect(showText, `${label}: API-210 must not contain "${token}"`).not.toContain(token);
      expect(msgText, `${label}: API-211 must not contain "${token}"`).not.toContain(token);
    }
    return { show: JSON.parse(showText), messages: JSON.parse(msgText) };
  };

  const atProblem = await scanVisitorSurface("status=problem");
  expect(atProblem.show.room.status_public).toBe("open");
  expect(atProblem.show.room.status).toBeUndefined();
  // DEC-074 — in_progress -> problem both project to 'open', so the transition
  // row is suppressed for the visitor entirely.
  expect(atProblem.messages.messages.map((m) => m.id)).toEqual(visibleBefore);

  await agent.getByLabel("Status").selectOption("done");
  await expect(agent.locator(".bc-pchat-room-head .bc-pchat-pill")).toHaveText("Done");
  const doneRow = json(
    `$r=App\\Models\\PublicChatRoom::withoutGlobalScopes()->whereKey('${room.id}')->firstOrFail();` +
      `echo json_encode(['status'=>$r->status->value,'closed_at'=>$r->closed_at?->toIso8601String()]);`,
  );
  expect(doneRow.status).toBe("done");
  expect(doneRow.closed_at).not.toBeNull();

  const atDone = await scanVisitorSurface("status=done");
  expect(atDone.show.room.status_public).toBe("closed");
  expect(atDone.show.can_send).toBe(false);
  expect(atDone.show.closed_reason).toBe("done");
  await expect(visitor.locator(".bc-pchat-composer")).toHaveCount(0);
  await expect(visitor.locator(".bc-pchat-banner")).toBeVisible();
  pass(
    "MANDATORY graft 1 / DEC-074 the visitor never sees `problem` in the page or in any reachable API response, and the zero-delta status row is suppressed; `done` closes the composer",
  );

  // ==================================================================== 11
  // CHECK 9 — ISOLATION. A public chat room is not a `rooms` row (DEC-064), so
  // it cannot appear in the ordinary room list; and a `rooms` id must be
  // rejected by every public-chat endpoint on every tier.
  const ordinary = await agentApi(agent.request, "GET", "/api/v1/rooms");
  expect(ordinary.status).toBe(200);
  expect(ordinary.text).not.toContain(room.id);
  expect(ordinary.text).not.toContain(customerName);
  expect(ordinary.text).not.toContain(room.code);
  await agent.goto(base + "/");
  await expect(agent.locator("aside")).toBeVisible();
  expect(await agent.locator("aside").innerText()).not.toContain(customerName);

  const isolation = { ordinary_room_list: ordinary.status };

  // Tier 3, with a real production room id, as the fixture agent.
  for (const [method, path, data] of [
    ["GET", "/api/v1/public-chat/rooms/" + realRoomId, undefined],
    ["GET", "/api/v1/public-chat/rooms/" + realRoomId + "/messages", undefined],
    ["POST", "/api/v1/public-chat/rooms/" + realRoomId + "/messages", { client_message_id: randomUUID(), body: "isolation probe" }],
    ["PATCH", "/api/v1/public-chat/rooms/" + realRoomId, { status: "done" }],
  ]) {
    const res = await agentApi(agent.request, method, path, data);
    expect({ path, status: res.status, code: res.body?.error?.code }).toEqual({
      path,
      status: 404,
      code: "PCHAT_ROOM_NOT_FOUND",
    });
    isolation["tier3 " + method + " " + path] = res.status;
  }

  // A real `messages` id must be equally unreachable through API-226, which
  // resolves against public_chat_messages — 404 before anything is written.
  const realMessageId = baseline.messages.ids[0];
  const deleteProbe = await agentApi(
    agent.request,
    "DELETE",
    "/api/v1/public-chat/messages/" + realMessageId,
  );
  expect({ status: deleteProbe.status, code: deleteProbe.body?.error?.code }).toEqual({
    status: 404,
    code: "PCHAT_ROOM_NOT_FOUND",
  });
  isolation["tier3 DELETE /public-chat/messages/<real message id>"] = deleteProbe.status;

  // Tier 1, signed, with the same real production room id — show and close.
  const partnerProbe = await signed("GET", "/api/v1/partner/public-chat/rooms/" + realRoomId);
  expectApiError(partnerProbe, 404, "PCHAT_ROOM_NOT_FOUND");
  isolation["tier1 GET /partner/.../rooms/<real room id>"] = partnerProbe.status;
  const partnerClose = await signed("POST", "/api/v1/partner/public-chat/rooms/" + realRoomId + "/close");
  expectApiError(partnerClose, 404, "PCHAT_ROOM_NOT_FOUND");
  isolation["tier1 POST /partner/.../rooms/<real room id>/close"] = partnerClose.status;

  // Tier 2 rejects it at ROUTING: ->where('code','[a-f0-9]{64}') means a ULID
  // never reaches a handler, so this is nginx/Laravel's 404 and carries no §7
  // envelope — the status is the whole assertion.
  const visitorProbe = await visitor.request.get(api + "/api/v1/public-chat/" + realRoomId);
  expect(visitorProbe.status()).toBe(404);
  isolation["tier2 GET /public-chat/<real room id>"] = visitorProbe.status();

  // The probes must not have touched that room.
  // BOTH tables carry a deleted_at column, and DB::table() ignores it — a row
  // count alone would still read 1 for a row the DELETE/PATCH probe had SOFT
  // deleted, i.e. it would pass over exactly the damage it exists to catch. The
  // deleted_at values are the real assertion; the counts only prove the row is
  // still there at all.
  const untouched = json(
    `echo json_encode(['room'=>DB::table('rooms')->where('id','${realRoomId}')->count(),` +
      `'room_deleted_at'=>DB::table('rooms')->where('id','${realRoomId}')->value('deleted_at'),` +
      `'message'=>DB::table('messages')->where('id','${realMessageId}')->count(),` +
      `'message_deleted_at'=>DB::table('messages')->where('id','${realMessageId}')->value('deleted_at')]);`,
  );
  expect(untouched.room).toBe(1);
  expect(untouched.message).toBe(1);
  expect(untouched.room_deleted_at, "the probed production room must not have been soft deleted").toBeNull();
  expect(untouched.message_deleted_at, "the probed production message must not have been soft deleted").toBeNull();
  evidence.probe_targets_untouched = untouched;
  evidence.isolation = isolation;
  pass(
    "DEC-064 the public chat room is absent from the ordinary room list and sidebar, and a real production room id is rejected by every public-chat endpoint on all three tiers",
    isolation,
  );

  // ==================================================================== 12
  // CHECK 10 — the code is a capability. It must never ride a response header,
  // and the SPA route that carries it must be no-referrer / no-store.
  const leakingHeaders = [];
  for (const entry of visitorHeaders) {
    for (const [name, value] of Object.entries(entry.headers)) {
      if (typeof value === "string" && value.includes(room.code)) {
        leakingHeaders.push({ url: entry.url, header: name });
      }
    }
  }
  expect(leakingHeaders).toEqual([]);
  expect(visitorHeaders.length).toBeGreaterThan(0);

  const supportDoc = await fetch(base + "/support/" + room.code, {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const referrerPolicy = supportDoc.headers.get("referrer-policy") ?? "";
  const cacheControl = supportDoc.headers.get("cache-control") ?? "";
  expect(supportDoc.status).toBe(200);
  // `includes`, not equality: an edge may append its own directives.
  expect(referrerPolicy.toLowerCase()).toContain("no-referrer");
  expect(cacheControl.toLowerCase()).toContain("no-store");
  for (const [name, value] of supportDoc.headers.entries()) {
    expect(value, `header ${name} must not carry the capability code`).not.toContain(room.code);
  }
  // Tier-2 JSON carries the same hygiene from the controller's noStore().
  const apiHygiene = await fetch(api + "/api/v1/public-chat/" + room.code, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  expect((apiHygiene.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  expect((apiHygiene.headers.get("referrer-policy") ?? "").toLowerCase()).toContain("no-referrer");
  evidence.support_headers = {
    "referrer-policy": referrerPolicy,
    "cache-control": cacheControl,
    responses_inspected: visitorHeaders.length,
  };
  pass(
    "DEC-063 the 64-hex code appears in no response header, and /support/<code> answers with Referrer-Policy: no-referrer and Cache-Control: no-store",
    evidence.support_headers,
  );

  expect(errors, "no uncaught browser errors on any public chat surface").toEqual([]);
  pass("FR-PCHAT-006/007 no uncaught browser errors on the visitor, queue or room pages");
} catch (e) {
  results.push({ test: "public chat verification", status: "failed", error: e.message });
  errors.push(e.stack ?? e.message);
  if (pages[0]) {
    try {
      await pages[0].screenshot({
        path: new URL((prod ? "production-" : "") + "public-chat-failure.png", import.meta.url).pathname,
      });
    } catch {
      /* page already closed */
    }
  }
  process.exitCode = 1;
} finally {
  // ==================================================================== 13
  // CLEANUP. Every step is independently try/caught so one failure cannot skip
  // the next, and EVERY failure here is a test failure in its own right.
  const cleanupStep = async (test, fn) => {
    try {
      await fn();
      pass(test);
    } catch (e) {
      results.push({ test, status: "failed", error: e.message });
      errors.push("cleanup: " + (e.stack ?? e.message));
      process.exitCode = 1;
    }
  };

  // 13.1 THE FLAG. First, before anything else can throw. A customer-facing
  // surface left switched on is the worst outcome this script can produce.
  await cleanupStep("FR-PCHAT-034 publicchat.enabled restored to its ORIGINAL value", async () => {
    if (originalFlag === null) throw new Error("original flag was never captured — cannot restore");

    // ONE restore code path, shared with the signal and 'exit' handlers, so the
    // interrupted run and the clean run put the row back the same way. It is a
    // no-op if a handler already did it.
    restoreFlagSync();

    const after = json(
      `$r=App\\Models\\AppSetting::query()->where('key','publicchat.enabled')->first();` +
        `echo json_encode(['row'=>$r===null?null:['value'=>$r->getRawOriginal('value')],` +
        `'effective'=>(bool) app(App\\Services\\SettingsService::class)->get('publicchat.enabled', false)]);`,
    );
    evidence.restored_flag = after;
    expect(after.effective, "the kill switch must end at its original value").toBe(originalEnabled);
    expect(after.row === null, "the app_settings row must end in its original presence state").toBe(
      originalFlag.row === null,
    );
    if (originalFlag.row !== null) {
      expect(String(after.row.value), "the raw app_settings value must be byte-identical").toBe(
        String(originalFlag.row.value),
      );
    }
  });

  // 13.2 CHECK 11 — and prove the restore actually gates again.
  await cleanupStep(
    "FR-PCHAT-034 a signed partner create is gated again once the flag is restored",
    async () => {
      // Nothing was ever issued and the flag was never touched: there is no
      // gate claim to re-prove, and inventing a failure row here would mask the
      // real error that aborted the run.
      if (apiKey === null && !flagChanged) return;
      if (apiKey === null) throw new Error("no api key was issued — cannot re-prove the gate");
      const res = await signed("POST", "/api/v1/partner/public-chat/rooms", {
        body: { customer_name: customerName + " post-restore", provider_name: providerName },
      });
      evidence.post_restore_create = { status: res.status, code: res.body?.error?.code };
      if (originalEnabled) {
        // Production had it ON; the honest assertion is that it still works.
        expect(res.status).toBe(201);
      } else {
        expectApiError(res, 503, "PCHAT_DISABLED");
      }
    },
  );

  // 13.3 The key: revoke (FR-PCHAT-032), then delete the row. Scoped by our own
  // row id AND our fixture workspace id.
  await cleanupStep("FR-PCHAT-032 the QA API key is revoked and deleted", async () => {
    if (apiKey === null || fixture === null) return;
    const revoked = json(
      `$k=App\\Models\\PublicChatApiKey::withoutGlobalScopes()->whereKey('${apiKey.id}')->where('workspace_id','${fixture.workspace}')->first();` +
        `if($k===null){echo json_encode(['revoked'=>null,'deleted'=>true]);return;}` +
        `app(App\\Domain\\PublicChat\\PublicChatApiKeyService::class)->revoke($k,null);` +
        `$at=$k->fresh()->revoked_at?->toIso8601String();` +
        `App\\Models\\PublicChatApiKey::withoutGlobalScopes()->whereKey('${apiKey.id}')->where('workspace_id','${fixture.workspace}')->delete();` +
        `echo json_encode(['revoked'=>$at,'deleted'=>App\\Models\\PublicChatApiKey::withoutGlobalScopes()->whereKey('${apiKey.id}')->count()===0]);`,
    );
    expect(revoked.deleted).toBe(true);
    evidence.key_revoked_at = revoked.revoked;
  });

  await cleanupStep("browser closed", async () => {
    if (browser !== null) await browser.close();
  });

  // 13.4 Fixture teardown. Scoped by the fixture workspace id AND its slug, so
  // a mistyped id can never match a real workspace.
  await cleanupStep("fixture workspace, rooms, messages and user removed", async () => {
    if (fixture === null) return;
    const gone = json(
      `$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->first();` +
        `if($w===null){echo json_encode(['workspace'=>0,'users'=>0,'pchat_rooms'=>0,'pchat_messages'=>0]);return;}` +
        // public_chat_reads (written by API-228 when the agent opened the room)
        // cascades on room_id, user_id AND workspace_id, so this is
        // belt-and-braces — but it makes teardown independent of FK behaviour.
        `App\\Models\\PublicChatRead::query()->where('workspace_id',$w->id)->delete();` +
        `App\\Models\\PublicChatMessage::withoutGlobalScopes()->where('workspace_id',$w->id)->delete();` +
        `App\\Models\\PublicChatRoom::withoutGlobalScopes()->where('workspace_id',$w->id)->forceDelete();` +
        `App\\Models\\PublicChatApiKey::withoutGlobalScopes()->where('workspace_id',$w->id)->delete();` +
        `$ids=$w->allMemberships()->pluck('user_id');` +
        `$w->delete();` +
        `App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();` +
        `echo json_encode(['workspace'=>DB::table('workspaces')->where('id','${fixture.workspace}')->count(),` +
        `'users'=>DB::table('users')->where('username','like','${prefix}%')->count(),` +
        `'pchat_rooms'=>DB::table('public_chat_rooms')->where('workspace_id','${fixture.workspace}')->count(),` +
        `'pchat_messages'=>DB::table('public_chat_messages')->where('workspace_id','${fixture.workspace}')->count()]);`,
    );
    expect(gone).toEqual({ workspace: 0, users: 0, pchat_rooms: 0, pchat_messages: 0 });
  });

  // 13.5 Nothing that was here before may have disappeared. Subset, not
  // equality: real users may legitimately have written during the run.
  await cleanupStep("PROD-SAFETY no pre-existing room, message, user or workspace disappeared", async () => {
    if (baseline === null) throw new Error("baseline was never captured");
    const after = json(SNAPSHOT_PHP);
    const missing = {};
    for (const table of Object.keys(baseline)) {
      const present = new Set(after[table].ids);
      const lost = baseline[table].ids.filter((id) => !present.has(id));
      if (lost.length > 0) missing[table] = lost;
      // >=, not ==: real users may legitimately have written during the run, so
      // equality would be a false failure. "Nothing disappeared" is the id-list
      // subset check above; the fixture's own rows are proved gone by 13.4.
      expect(
        after[table].count,
        `${table}: ${after[table].count} rows now vs ${baseline[table].count} at the start`,
      ).toBeGreaterThanOrEqual(baseline[table].count);
    }
    evidence.after_counts = Object.fromEntries(
      Object.entries(after).map(([k, v]) => [k, v.count]),
    );
    expect(missing, "pre-existing rows disappeared").toEqual({});
  });

  // The plaintext secret is shown exactly once, by issue(). A failing
  // assertion message could otherwise carry it into this file — redact it on
  // the way out so the one-time property survives even a failed run.
  const redact = (text) => {
    let out = text;
    if (apiKey?.secret) out = out.split(apiKey.secret).join("pcs_<redacted>");
    if (password) out = out.split(password).join("<redacted-fixture-password>");
    return out;
  };

  await writeFile(
    new URL((prod ? "production-" : "") + "public-chat-results.json", import.meta.url).pathname,
    redact(JSON.stringify(
      {
        run: prefix,
        base,
        production: prod,
        results,
        evidence,
        screenshots: shots,
        errors,
        exit_code: process.exitCode ?? 0,
      },
      null,
      2,
    ) + "\n"),
  );

  console.log(redact(JSON.stringify(results, null, 2)));
  if ((process.exitCode ?? 0) !== 0) console.error(redact(JSON.stringify(errors, null, 2)));
}
