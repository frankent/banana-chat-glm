/**
 * FR-ROOM-012 / DEC-056 — production verification of secret rooms.
 * Production counterpart of TC-ROOM-070..082 (the Pest suite proves the same
 * behaviour locally; only this script can prove the every-minute
 * ExpireSecretRooms scheduler actually runs on the live box and that it
 * touches nothing outside the fixture).
 *
 * Run: MEETING_QA_PRODUCTION=1 node verify-secret-rooms.mjs
 * Results: secret-rooms-results.json next to this file.
 *
 * Prod safety: everything lives in a throwaway workspace created with a
 * time-based prefix. Every SQL write is scoped by that workspace id (and, for
 * the back-date, by one exact room id). Cleanup runs in `finally`.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../../../../apps/web/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const prod = process.env.MEETING_QA_PRODUCTION === "1";
const base = prod ? "https://chat.gamecoms.net" : "http://127.0.0.1:5173";
const api = (prod ? base : "http://localhost:18000") + "/api/v1";
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
const shot = (name) =>
  new URL((prod ? "production-" : "") + name, import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prefix = "secretqa" + Date.now();
const password = randomBytes(20).toString("hex");
// Fixture: own workspace + two members. Nothing outside it is ever written.
const fixture = JSON.parse(
  php(
    `$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Secret room QA','status'=>'active']);$users=[];$ids=[];foreach(['Sunee Creator','Bailey Partner'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'member']);$users[]=$u->username;$ids[]=$u->id;}echo json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'users'=>$users,'user_ids'=>$ids,'names'=>['Sunee Creator','Bailey Partner']]);`,
  ),
);
const ws = fixture.workspace;
// TC-ROOM-078 guard, half 1: every production room OUTSIDE the fixture.
// Raw table query — no model scopes — so soft-deleted rows count too.
const outsideQuery = `Illuminate\\Support\\Facades\\DB::table('rooms')->where('workspace_id','<>','${ws}')`;
const snapshot = () =>
  JSON.parse(
    php(
      `echo json_encode(['count'=>${outsideQuery}->count(),'ids'=>${outsideQuery}->orderBy('id')->pluck('id')->all()]);`,
    ),
  );
const before = snapshot();

const browser = await chromium.launch({ channel: "chrome" });
const results = [];
const errors = [];
const frames = [];
const evidence = { prodRoomsOutsideFixture: { before: before.count } };
let page = null;
let token = "";
const fail = (test, error) => {
  results.push({ test, status: "failed", error: String(error) });
  process.exitCode = 1;
};

/** Authenticated API helpers — always the fixture user, always the fixture workspace. */
const headers = () => ({
  Authorization: "Bearer " + token,
  Accept: "application/json",
  "X-Workspace-Id": fixture.slug,
});
const apiPost = (path, data) =>
  page.request.post(api + path, { headers: headers(), data });
const apiGet = (path) => page.request.get(api + path, { headers: headers() });
const body = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const createRoom = (data) => apiPost("/rooms", data);
const sendMessage = (roomId, text) =>
  apiPost(`/rooms/${roomId}/messages`, {
    client_message_id: randomUUID(),
    body: text,
  });

/** Room row / message / audit state for one of OUR rooms. */
const roomState = (rid) =>
  JSON.parse(
    php(
      `echo json_encode(['room'=>Illuminate\\Support\\Facades\\DB::table('rooms')->where('id','${rid}')->count(),'messages'=>Illuminate\\Support\\Facades\\DB::table('messages')->where('room_id','${rid}')->count(),'members'=>Illuminate\\Support\\Facades\\DB::table('room_members')->where('room_id','${rid}')->count(),'audit'=>Illuminate\\Support\\Facades\\DB::table('audit_logs')->where('action','room.secret_expired')->where('target_id','${rid}')->count()]);`,
    ),
  );

/** Every member-facing surface of an expired secret room (spec FR-ROOM-012). */
async function expiredSurfaces(rid) {
  const calls = [
    ["room detail", () => apiGet(`/rooms/${rid}`)],
    ["messages list", () => apiGet(`/rooms/${rid}/messages`)],
    [
      "send message",
      () =>
        apiPost(`/rooms/${rid}/messages`, {
          client_message_id: randomUUID(),
          body: "must not land",
        }),
    ],
    ["mark read", () => apiPost(`/rooms/${rid}/read`, { seq: 1 })],
    ["members", () => apiGet(`/rooms/${rid}/members`)],
  ];
  return Promise.all(
    calls.map(async ([surface, run]) => {
      const res = await run();
      const payload = await body(res);
      return { surface, status: res.status(), code: payload?.error?.code ?? null };
    }),
  );
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  // EVT-003 proof: capture the raw Reverb frames before anything can arrive.
  page.on("websocket", (socket) =>
    socket.on("framereceived", (f) => frames.push(String(f.payload))),
  );
  // Access token: captured on login and re-captured on every rotation, so a
  // reload (refresh token lives in localStorage — DEC-011) cannot strand us
  // on a stale bearer.
  page.on("response", async (res) => {
    const path = new URL(res.url()).pathname;
    if ((path.endsWith("/auth/login") || path.endsWith("/auth/refresh")) && res.ok()) {
      token = (await body(res))?.access_token ?? token;
    }
  });

  // --- single login (throttle: 5/min/IP, 10/15min/username) ---
  await page.goto(base + "/login");
  await page.getByLabel("Username").fill(fixture.users[0]);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("aside")).toBeVisible();
  await expect.poll(() => token !== "").toBe(true);

  // ---------------------------------------------------------------
  // 1. TC-ROOM-071 — create a secret GROUP from the real creator UI
  // ---------------------------------------------------------------
  await page.getByRole("button", { name: "+ Group", exact: true }).click();
  await page.getByPlaceholder("Group name").fill(prefix + " secret group");
  await page.getByPlaceholder("Search people…").fill(fixture.names[1]);
  await page
    .getByRole("button", { name: new RegExp("@" + fixture.users[1]) })
    .click();
  const toggle = page.getByTestId("secret-toggle").locator("input[type=checkbox]");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByTestId("secret-options")).toBeVisible();
  // DEC-056: the UI must say "expiring", not "encrypted".
  await expect(page.getByTestId("secret-explain")).toContainText(
    "not end-to-end encrypted",
  );
  await page.getByTestId("secret-expiry").selectOption("3");
  await page.getByRole("button", { name: /^Create group/ }).click();
  // App ULIDs are lowercase Crockford (App\Concerns\HasUlid does
  // strtolower(Str::ulid())), so the pattern must be lowercase.
  await expect(page).toHaveURL(/\/rooms\/[0-9a-hjkmnp-tv-z]{26}$/);
  const secretRoomId = new URL(page.url()).pathname.split("/").pop();
  await expect(page.getByTestId("secret-expiry-header")).toContainText("🔒");
  await expect(page.getByTestId("secret-expiry-header")).toContainText("deletes");
  const badge = page
    .locator(`a[href="/rooms/${secretRoomId}"]`)
    .getByTestId("secret-room-badge");
  // secretExpiryShort = ceil((expires_at - client_now)/1d). expires_at is
  // server_now + 3d, so any clock skew where this machine trails the prod box
  // rounds the label up to 4d. Accept 3 or 4 (the exact deadline is asserted
  // on the wire below, with the same ±10min skew tolerance).
  await expect(badge).toHaveText(/^🔒 [34]d$/);
  await page.screenshot({ path: shot("secret-room-created.png"), fullPage: true });
  const secretDetail = await body(await apiGet(`/rooms/${secretRoomId}`));
  expect(secretDetail.data.room.is_secret).toBe(true);
  const expiresAt = Date.parse(secretDetail.data.room.secret_expires_at);
  expect(Math.abs(expiresAt - (Date.now() + 3 * 86400000))).toBeLessThan(600000);
  results.push({
    test: "TC-ROOM-071 secret group created from the UI toggle + day picker; 🔒 badge and expiry hint shown",
    status: "passed",
    roomId: secretRoomId,
    secret_expires_at: secretDetail.data.room.secret_expires_at,
  });

  // ---------------------------------------------------------------
  // 2. TC-ROOM-072 — API-020 expiry_days validation
  // ---------------------------------------------------------------
  const group = (extra) => ({
    type: "group",
    name: prefix + " v" + Math.random().toString(36).slice(2, 7),
    member_ids: [fixture.user_ids[1]],
    ...extra,
  });
  const validation = [];
  for (const [label, payload, expected] of [
    ["expiry_days 31 with secret", group({ secret: true, expiry_days: 31 }), 422],
    ["expiry_days 0 with secret", group({ secret: true, expiry_days: 0 }), 422],
    ["expiry_days without secret", group({ expiry_days: 5 }), 422],
    ["secret without expiry_days", group({ secret: true }), 422],
    ["expiry_days 1 (lower bound)", group({ secret: true, expiry_days: 1 }), 201],
    ["expiry_days 30 (upper bound)", group({ secret: true, expiry_days: 30 }), 201],
  ]) {
    const res = await createRoom(payload);
    const payloadBody = await body(res);
    validation.push({ label, status: res.status(), expected });
    expect(res.status(), label).toBe(expected);
    if (expected === 201) {
      expect(payloadBody.data.room.is_secret).toBe(true);
      expect(payloadBody.data.room.secret_expires_at).not.toBe(null);
    }
  }
  results.push({
    test: "TC-ROOM-072 API-020 rejects expiry_days 0/31 and expiry_days without secret (422); bounds 1 and 30 create (201)",
    status: "passed",
    validation,
  });

  // ---------------------------------------------------------------
  // 3. TC-ROOM-070 — secret DM lives in its own dm_key namespace
  // ---------------------------------------------------------------
  const secretDmRes = await createRoom({
    type: "dm",
    user_id: fixture.user_ids[1],
    secret: true,
    expiry_days: 2,
  });
  expect(secretDmRes.status()).toBe(201);
  const secretDm = (await body(secretDmRes)).data.room;
  const plainDmRes = await createRoom({ type: "dm", user_id: fixture.user_ids[1] });
  expect(plainDmRes.status()).toBe(201);
  const plainDm = (await body(plainDmRes)).data.room;
  expect(secretDm.id).not.toBe(plainDm.id);
  expect(secretDm.is_secret).toBe(true);
  expect(plainDm.is_secret === false || plainDm.is_secret == null).toBe(true);
  expect(plainDm.secret_expires_at ?? null).toBe(null);
  // both usable
  for (const [rid, text] of [
    [secretDm.id, "secret dm probe"],
    [plainDm.id, "ordinary dm probe"],
  ]) {
    expect((await sendMessage(rid, text)).status()).toBe(201);
    const list = await body(await apiGet(`/rooms/${rid}/messages`));
    expect(list.data.messages.some((m) => m.body === text)).toBe(true);
  }
  // dedupe still works inside each namespace, independently
  const plainAgain = await createRoom({ type: "dm", user_id: fixture.user_ids[1] });
  expect(plainAgain.status()).toBe(200);
  expect((await body(plainAgain)).data.room.id).toBe(plainDm.id);
  const secretAgain = await createRoom({
    type: "dm",
    user_id: fixture.user_ids[1],
    secret: true,
    expiry_days: 2,
  });
  expect(secretAgain.status()).toBe(200);
  expect((await body(secretAgain)).data.room.id).toBe(secretDm.id);
  results.push({
    test: "TC-ROOM-070 secret DM and ordinary DM between the same pair are different rooms, both usable, each deduping in its own namespace",
    status: "passed",
    secretDmId: secretDm.id,
    plainDmId: plainDm.id,
  });

  // ---------------------------------------------------------------
  // 5a. ordinary control room (asserted again after the purge)
  // ---------------------------------------------------------------
  const ordinaryRes = await createRoom({
    type: "group",
    name: prefix + " ordinary group",
    member_ids: [fixture.user_ids[1]],
  });
  expect(ordinaryRes.status()).toBe(201);
  const ordinaryId = (await body(ordinaryRes)).data.room.id;
  expect((await sendMessage(ordinaryId, "ordinary before purge")).status()).toBe(201);

  // ---------------------------------------------------------------
  // 4. THE DESTRUCTIVE PATH — TC-ROOM-073/078/080
  // ---------------------------------------------------------------
  expect((await sendMessage(secretRoomId, "this must be destroyed")).status()).toBe(201);
  const beforeExpiry = roomState(secretRoomId);
  expect(beforeExpiry.room).toBe(1);
  expect(beforeExpiry.messages).toBeGreaterThan(0);

  /**
   * Back-date ONE of our own secret rooms and probe every surface. Returns
   * null when the every-minute sweeper beat us to the row (then the surfaces
   * answer 404, not 410, and the assertion would be meaningless).
   */
  async function backdateAndProbe(rid) {
    // The scheduler dispatches ExpireSecretRooms at :00 every minute. Back-date
    // just after a minute boundary so the 410 assertions (which must be true
    // BEFORE the sweeper runs) get a ~35s margin.
    for (;;) {
      const s = new Date().getSeconds();
      if (s >= 3 && s <= 25) break;
      await sleep(500);
    }
    // Scoped by the exact room id AND the fixture workspace AND is_secret.
    const updated = php(
      `echo Illuminate\\Support\\Facades\\DB::table('rooms')->where('id','${rid}')->where('workspace_id','${ws}')->where('is_secret',true)->update(['secret_expires_at'=>now()->subSeconds(30)]);`,
    ).trim();
    expect(updated, "back-date must touch exactly one row").toBe("1");
    const at = new Date().toISOString();
    const probed = await expiredSurfaces(rid);
    if (probed.some((s) => s.status === 404) && roomState(rid).room === 0) {
      return null; // swept mid-probe
    }
    return { at, probed };
  }

  let destructiveRoomId = secretRoomId;
  let probe = await backdateAndProbe(destructiveRoomId);
  if (probe === null) {
    // Sweeper raced the probe. Retry once on a fresh secret room of our own.
    const retryRes = await createRoom({
      type: "group",
      name: prefix + " secret retry",
      member_ids: [fixture.user_ids[1]],
      secret: true,
      expiry_days: 1,
    });
    expect(retryRes.status()).toBe(201);
    destructiveRoomId = (await body(retryRes)).data.room.id;
    expect((await sendMessage(destructiveRoomId, "this must be destroyed")).status()).toBe(201);
    // The retry room was created over the API, so the open client has never
    // seen it. Open it and prove the sidebar row exists BEFORE expiring it —
    // otherwise the EVT-003 eviction assertions below (link count 0) would
    // pass vacuously on a room the UI never rendered.
    await page.goto(base + "/rooms/" + destructiveRoomId);
    await expect(page.locator("aside")).toBeVisible();
    await expect(page.locator(`a[href="/rooms/${destructiveRoomId}"]`)).toHaveCount(1);
    probe = await backdateAndProbe(destructiveRoomId);
  }
  if (probe === null) {
    throw new Error(
      "ExpireSecretRooms swept the room before the 410 probe could run, twice — rerun the script",
    );
  }
  const { at: expiredAt, probed: surfaces } = probe;
  for (const s of surfaces) {
    expect(s.status, s.surface).toBe(410);
    expect(s.code, s.surface).toBe("ROOM_EXPIRED");
  }
  // 410 is itself proof the sweeper had not run: RoomPolicy only throws it
  // after findOrFail() loaded the still-present row.
  const listAfterExpiry = await body(await apiGet("/rooms?limit=100"));
  expect(listAfterExpiry.data.some((i) => i.room.id === destructiveRoomId)).toBe(false);
  results.push({
    test: "TC-ROOM-073 expired secret room answers 410 ROOM_EXPIRED on every surface before the sweeper runs, and vanishes from the room list",
    status: "passed",
    roomId: destructiveRoomId,
    expiredAt,
    surfaces,
  });

  // 4b. the every-minute scheduler hard-deletes room + messages
  const startedWaiting = Date.now();
  const deadline = startedWaiting + 150000;
  let purge = roomState(destructiveRoomId);
  while (Date.now() < deadline && (purge.room > 0 || purge.messages > 0)) {
    await sleep(5000);
    purge = roomState(destructiveRoomId);
  }
  expect(purge.room, "room row still present after the sweeper window").toBe(0);
  expect(purge.messages, "messages still present after the sweeper window").toBe(0);
  expect(purge.members).toBe(0);
  expect(purge.audit).toBeGreaterThan(0);
  results.push({
    test: "TC-ROOM-078 ExpireSecretRooms hard-deleted the room, its messages and members within the sweeper window; audit room.secret_expired recorded",
    status: "passed",
    waitedMs: Date.now() - startedWaiting,
    finalState: purge,
  });

  // 4b(ii). the client reacts — EVT-003 room.deleted, then UI eviction
  // The broadcast is afterCommit → queue → Reverb, so it lands a little after
  // the row disappears; poll (yielding the event loop) instead of reading the
  // buffer synchronously right after a blocking ssh call. Not a hard failure:
  // the 410-refetch eviction path is equally spec-compliant.
  let sawEvent = false;
  try {
    await expect
      .poll(
        () =>
          frames.some(
            (f) => f.includes("room.deleted") && f.includes(destructiveRoomId),
          ),
        { timeout: 30000 },
      )
      .toBe(true);
    sawEvent = true;
  } catch {
    sawEvent = false;
  }
  let reloadFallback = false;
  try {
    await expect
      .poll(
        async () =>
          (await page.getByTestId("secret-room-expired").count()) > 0 ||
          new URL(page.url()).pathname === "/",
        { timeout: 30000 },
      )
      .toBe(true);
  } catch {
    reloadFallback = true;
    await page.reload();
    await expect(page.locator("aside")).toBeVisible();
  }
  await expect(page.locator(`a[href="/rooms/${destructiveRoomId}"]`)).toHaveCount(0);
  results.push({
    test: "EVT-003 the member's open client evicts the purged secret room from the room list",
    status: "passed",
    roomDeletedFrameSeen: sawEvent,
    reloadFallback,
    evictionTrigger: sawEvent ? "EVT-003 room.deleted" : "410 ROOM_EXPIRED refetch",
    note: reloadFallback
      ? "room.deleted did not settle the open view within 30s; eviction asserted after a reload instead"
      : "evicted live (room.deleted broadcast and/or the 410 refetch)",
  });
  await page.screenshot({ path: shot("secret-room-purged.png"), fullPage: true });

  // ---------------------------------------------------------------
  // 5b. TC-ROOM-082 — ordinary rooms unaffected by the purge
  // ---------------------------------------------------------------
  expect((await sendMessage(ordinaryId, "ordinary after purge")).status()).toBe(201);
  const ordinaryDetail = (await body(await apiGet(`/rooms/${ordinaryId}`))).data.room;
  expect(ordinaryDetail.is_secret).toBe(false);
  expect(ordinaryDetail.secret_expires_at).toBe(null);
  // The ordinary control room was created over the API, so nothing in the open
  // client necessarily invalidated the room list. Reload once (the refresh
  // token lives in localStorage — DEC-011 — so the session survives) to make
  // the sidebar assertions below deterministic rather than dependent on an
  // incidental refetch.
  await page.reload();
  await expect(page.locator("aside")).toBeVisible();
  const ordinaryLink = page.locator(`a[href="/rooms/${ordinaryId}"]`);
  await expect(ordinaryLink).toHaveCount(1);
  await expect(ordinaryLink.getByTestId("secret-room-badge")).toHaveCount(0);
  const plainDmStill = await apiGet(`/rooms/${plainDm.id}`);
  expect(plainDmStill.status()).toBe(200);
  results.push({
    test: "TC-ROOM-082 ordinary rooms keep working after the secret purge and carry no secret indicator",
    status: "passed",
    ordinaryId,
  });
  await page.screenshot({ path: shot("ordinary-room-after-purge.png"), fullPage: true });

  expect(errors).toEqual([]);
  results.push({ test: "FR-ROOM-012 no uncaught browser errors", status: "passed" });
} catch (e) {
  fail("verify-secret-rooms", e.message);
  if (page) {
    await page
      .screenshot({ path: shot("secret-rooms-failure.png"), fullPage: true })
      .catch(() => undefined);
  }
} finally {
  await browser.close().catch(() => undefined);
  // Cleanup, scoped to the fixture workspace only. Neither Room nor Workspace
  // uses SoftDeletes, so these are hard deletes; room children cascade by FK.
  // Each statement is independent: one failure (an unexpected FK, a row
  // already gone) must not abort the rest and leak the fixture into
  // production. Every predicate is a value this run created.
  let cleanup = "failed";
  try {
    cleanup = JSON.parse(
      php(
        `$r=[];` +
          `$steps=[` +
          `'rooms'=>fn()=>Illuminate\\Support\\Facades\\DB::table('rooms')->where('workspace_id','${ws}')->delete(),` +
          `'audit_logs'=>fn()=>Illuminate\\Support\\Facades\\DB::table('audit_logs')->where('workspace_id','${ws}')->delete(),` +
          `'workspace'=>fn()=>(int)(bool)optional(App\\Models\\Workspace::where('id','${ws}')->where('slug','${prefix}')->first())->delete(),` +
          `'users'=>fn()=>App\\Models\\User::whereIn('username',['${prefix}0','${prefix}1'])->where('username','like','${prefix}%')->delete(),` +
          `];` +
          `foreach($steps as $k=>$fn){try{$r[$k]=$fn();}catch(\\Throwable $e){$r[$k]='ERROR: '.$e->getMessage();}}` +
          `$r['leftover_rooms']=Illuminate\\Support\\Facades\\DB::table('rooms')->where('workspace_id','${ws}')->count();` +
          `$r['leftover_users']=App\\Models\\User::whereIn('username',['${prefix}0','${prefix}1'])->count();` +
          `$r['leftover_workspace']=App\\Models\\Workspace::where('id','${ws}')->where('slug','${prefix}')->count();` +
          `echo json_encode($r);`,
      ),
    );
    const leaked =
      cleanup.leftover_rooms > 0 ||
      cleanup.leftover_users > 0 ||
      cleanup.leftover_workspace > 0 ||
      Object.values(cleanup).some((v) => typeof v === "string" && v.startsWith("ERROR: "));
    if (leaked) {
      errors.push("cleanup left fixture rows behind: " + JSON.stringify(cleanup));
      process.exitCode = 1;
    }
  } catch (e) {
    cleanup = "failed: " + e.message;
    errors.push("cleanup: " + e.message);
    process.exitCode = 1;
  }
  // TC-ROOM-078 guard, half 2 — nothing outside the fixture may have moved.
  let after = null;
  try {
    after = snapshot();
    const missingIds = before.ids.filter((id) => !after.ids.includes(id));
    const addedIds = after.ids.filter((id) => !before.ids.includes(id));
    evidence.prodRoomsOutsideFixture = {
      before: before.count,
      after: after.count,
      unchanged: before.count === after.count,
      missingIds,
      // Real users creating rooms during the run is normal traffic, not
      // damage — reported, never failed on. Disappearance is the damage signal.
      addedIds,
    };
    if (missingIds.length > 0) {
      fail(
        "TC-ROOM-078 production rooms outside the fixture workspace are unchanged across the run",
        `before=${before.count} after=${after.count} missing=${JSON.stringify(missingIds)}`,
      );
    } else {
      results.push({
        test: "TC-ROOM-078 production rooms outside the fixture workspace are unchanged across the run (ExpireSecretRooms touched nothing real)",
        status: "passed",
        before: before.count,
        after: after.count,
      });
    }
  } catch (e) {
    fail("TC-ROOM-078 production room-count guard", e.message);
  }
  await writeFile(
    new URL("secret-rooms-results.json", import.meta.url),
    JSON.stringify(
      { fixture: { workspace: ws, slug: fixture.slug }, results, errors, evidence, cleanup },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify({ results, evidence }, null, 2));
