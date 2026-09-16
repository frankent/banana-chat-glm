import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

/**
 * FR-WEB-001 / DEC-058 / TC-WEB-071 — mobile input ergonomics on PRODUCTION.
 *
 * DEC-058 pins a 16px computed font-size floor on every editable control under
 * `@media (pointer: coarse)` (apps/web/src/index.css:226) and ships a viewport
 * meta with `interactive-widget=resizes-content` while deliberately KEEPING
 * pinch zoom available (apps/web/index.html) — so `user-scalable=no` and a
 * `maximum-scale` lock must both stay absent.
 *
 * COVERAGE HONESTY: Chromium — even with iPhone 13 device emulation — does not
 * reproduce iOS Safari's real focus auto-zoom, and no real iOS device is driven
 * here. This script proves the CSS and meta DEFENCES ARE LIVE ON PRODUCTION; it
 * does not prove the device behaviour. `visualViewport.scale` is therefore a
 * weak signal in Chromium (trivially 1) and is asserted only as a regression
 * tripwire. The load-bearing evidence is the computed-font-size sweep plus the
 * two probes that prove the deployed stylesheet actually wins the cascade.
 */

const require = createRequire(
  new URL("../../../../apps/web/package.json", import.meta.url),
);
const { chromium, devices, expect } = require("@playwright/test");
const prod = process.env.MEETING_QA_PRODUCTION === "1";
const base = prod ? "https://chat.gamecoms.net" : "http://127.0.0.1:5173";

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

// Throwaway fixture only. Every later query/update is scoped to this workspace id.
// PROD SAFETY: the whole create runs inside ONE DB transaction. This call sits
// outside the try/finally below (there is nothing to clean up before it
// succeeds), so a half-finished fixture would leak a workspace/user row into
// production with no teardown path. All-or-nothing removes that hole.
const prefix = "mobileqa" + Date.now();
const password = randomBytes(20).toString("hex");
const roomName = "Mobile QA room";
const fixture = JSON.parse(
  php(
    `echo Illuminate\\Support\\Facades\\DB::transaction(function(){$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Mobile QA','status'=>'active']);$users=[];foreach(['Mobile Tester','Mobile Peer'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'member']);$users[]=$u;}$r=App\\Models\\Room::create(['workspace_id'=>$w->id,'type'=>'group','name'=>'${roomName}','created_by'=>$users[0]->id,'member_count'=>2]);foreach($users as $u)$r->members()->attach($u->id,['workspace_id'=>$w->id,'role'=>'member']);return json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'users'=>array_map(fn($u)=>$u->username,$users),'room'=>$r->id]);});`,
  ),
);

const results = [];
const errors = [];
const surfaces = [];
const evidence = {};
const shotPath = (name) =>
  new URL((prod ? "production-" : "") + name, import.meta.url).pathname;

/**
 * Collect every VISIBLE editable control and its computed font-size.
 * Mirrors the selector in index.css:227 exactly — non-textual input types
 * (button/submit/reset/checkbox/radio/range/file/color/image/hidden) never
 * trigger iOS focus zoom and are excluded by the floor too.
 */
function sweepScript() {
  const selector =
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="image"]):not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"])';
  const describe = (el) => {
    const bits = [el.tagName.toLowerCase()];
    const type = el.getAttribute("type");
    if (type !== null) bits.push(`[type=${type}]`);
    if (el.id !== "") bits.push(`#${el.id}`);
    const testid = el.getAttribute("data-testid");
    if (testid !== null) bits.push(`[data-testid="${testid}"]`);
    const name = el.getAttribute("name");
    if (name !== null) bits.push(`[name="${name}"]`);
    const aria = el.getAttribute("aria-label");
    if (aria !== null) bits.push(`[aria-label="${aria}"]`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder !== null) bits.push(`[placeholder="${placeholder}"]`);
    const label = el.closest("label");
    if (label !== null && (label.textContent ?? "").trim() !== "")
      bits.push(`(label: ${(label.textContent ?? "").trim().slice(0, 40)})`);
    const cls = el.getAttribute("class");
    if (cls !== null && cls.trim() !== "")
      bits.push(`.${cls.trim().split(/\s+/)[0]}`);
    return bits.join("");
  };
  const visible = Array.from(document.querySelectorAll(selector)).filter(
    (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    },
  );
  const controls = visible.map((el) => ({
    control: describe(el),
    fontSize: window.getComputedStyle(el).fontSize,
  }));
  return {
    checked: controls.length,
    controls,
    offenders: controls.filter((c) => parseFloat(c.fontSize) < 16),
  };
}

/** Records the surface and fails with a per-control report when anything is under 16px. */
async function sweep(page, surface, { minControls = 1 } = {}) {
  const found = await page.evaluate(sweepScript);
  surfaces.push({
    surface,
    checked: found.checked,
    offenders: found.offenders,
    controls: found.controls,
  });
  expect(
    found.checked,
    `${surface}: swept ${found.checked} editable controls — the sweep found nothing to measure, so it proves nothing`,
  ).toBeGreaterThanOrEqual(minControls);
  expect(
    found.offenders,
    `${surface}: editable controls under 16px would auto-zoom on focus (DEC-058)`,
  ).toEqual([]);
  return found;
}

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  ...devices["iPhone 13"],
  hasTouch: true,
  locale: "en-US",
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
page.on("pageerror", (e) => errors.push(e.message));

try {
  // ---------------------------------------------------------------- check 1
  // The SERVED document (raw HTTP, before React runs) must carry the DEC-058
  // viewport meta, and must NOT lock zoom — keeping pinch zoom is a deliberate
  // accessibility decision, so its absence is asserted, not merely tolerated.
  const served = await (await page.request.get(base + "/")).text();
  const servedMeta = /<meta[^>]+name=["']viewport["'][^>]*>/i.exec(served);
  expect(servedMeta, "served document must contain a viewport meta tag").not.toBeNull();
  const servedContent = /content=["']([^"']*)["']/i.exec(servedMeta[0])?.[1] ?? "";
  evidence.servedViewportMeta = servedContent;
  expect(
    servedContent,
    "served viewport meta: Android keyboard must resize the layout so the composer stays visible",
  ).toContain("interactive-widget=resizes-content");
  expect(
    servedContent,
    "served viewport meta: pinch zoom must stay enabled (no user-scalable=no)",
  ).not.toMatch(/user-scalable\s*=\s*no/i);
  expect(
    servedContent,
    "served viewport meta: pinch zoom must stay enabled (no maximum-scale lock)",
  ).not.toMatch(/maximum-scale/i);

  await page.goto(base + "/login");

  // Guard: the whole DEC-058 floor lives behind `@media (pointer: coarse)`, so
  // the sweep is meaningless unless the emulated device reports a coarse pointer.
  expect(
    await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    ),
    "emulated iPhone 13 context must report a coarse primary pointer",
  ).toBe(true);
  evidence.viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));

  // The live DOM meta must match the served one (no runtime rewrite).
  const domMeta = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  evidence.domViewportMeta = domMeta;
  expect(domMeta, "live DOM viewport meta").toBe(servedContent);
  results.push({
    test: "TC-WEB-071 production viewport meta enables interactive-widget=resizes-content and keeps pinch zoom",
    status: "passed",
    meta: servedContent,
  });

  // ---------------------------------------------------------------- check 2a
  await expect(page.getByLabel("Username")).toBeVisible({ timeout: 30000 });
  await sweep(page, "login page", { minControls: 2 });
  await page.screenshot({ path: shotPath("mobile-01-login.png") });

  // Single login for the whole run — the throttle is 5/min/IP, 10/15min/username.
  // The per-IP bucket is SHARED with every sibling verify-*.mjs the orchestrator
  // runs from this host, so a 429 here is an environmental collision, not a
  // DEC-058 defect. Untreated it would surface only as "aside never appeared"
  // after a 30s timeout and be misread as a real failure — so the click is
  // retried once after Retry-After (2 attempts max, far under 10/15min/username)
  // and the final status is asserted explicitly with a message that names the
  // throttle. fixtures.ts uses the same Retry-After-then-retry-once shape.
  await page.getByLabel("Username").fill(fixture.users[0]);
  await page.getByLabel("Password").fill(password);
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  const loginAttempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Armed BEFORE the click so a fast response cannot be missed.
    const settled = page.waitForResponse(
      (r) =>
        r.url().endsWith("/auth/login") && r.request().method() === "POST",
      { timeout: 30000 },
    );
    await signIn.click();
    const res = await settled;
    const retryAfter = Math.min(
      Number(res.headers()["retry-after"] ?? 30) || 30,
      65,
    );
    loginAttempts.push({
      attempt,
      status: res.status(),
      ok: res.ok(),
      ...(res.status() === 429 ? { retryAfter } : {}),
    });
    evidence.login = loginAttempts;
    if (res.status() !== 429 || attempt === 2) break;
    await page.waitForTimeout(retryAfter * 1000 + 500);
  }
  // Assert ok(), not a hard-coded 200 — the exact 2xx the endpoint returns is
  // not something this script should pin, and a wrong guess would itself be a
  // false defect. The status still lands in the message and in the evidence.
  const lastLogin = loginAttempts[loginAttempts.length - 1];
  expect(
    lastLogin.ok,
    `POST /auth/login returned ${lastLogin.status}; 429 means the shared 5/min/IP login throttle was hit — ENVIRONMENTAL, not a DEC-058 defect`,
  ).toBe(true);
  await expect(page.locator("aside")).toBeVisible({ timeout: 30000 });

  // ---------------------------------------------------------------- check 2b
  // NewRoomDialog collapses to two buttons until expanded, so its inputs only
  // exist once opened. The sidebar is open at '/' (AppShell keys it to pathname).
  const newRoom = page.locator(".bc-new-room");
  await newRoom.getByRole("button", { name: "+ Group" }).click();
  await expect(page.getByPlaceholder("Group name")).toBeVisible({ timeout: 30000 });
  await sweep(page, "new room dialog", { minControls: 2 });
  await page.screenshot({ path: shotPath("mobile-02-new-room.png") });
  await newRoom.getByRole("button", { name: "✕" }).click();

  // ---------------------------------------------------------------- check 2c
  await page.locator("aside").getByText(roomName).first().click();
  // PROD SAFETY: everything below this line types into a composer (draft +
  // typing-indicator writes). Prove we are inside the fixture room BEFORE a
  // single keystroke can reach a room this script did not create. The fixture
  // user is a member of nothing else, so this can only ever be our own room —
  // this assertion makes that an enforced invariant rather than an inference.
  await expect(page).toHaveURL(new RegExp(`/rooms/${fixture.room}$`), {
    timeout: 30000,
  });
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeVisible({ timeout: 30000 });
  await sweep(page, "room view composer");
  await page.screenshot({ path: shotPath("mobile-03-room-composer.png") });
  results.push({
    test: "TC-WEB-071 login, new-room dialog and room composer editable controls are all >= 16px",
    status: "passed",
  });

  // ---------------------------------------------------------------- check 3
  // The sweep must be falsifiable AND the deployed stylesheet must be the thing
  // doing the work. Two probes:
  //   A — plain inline `font-size:11px`. The floor's `!important` outranks a
  //       non-important inline declaration, so A computing to 16px proves the
  //       DEC-058 rule is LIVE on production, not merely that nothing is small.
  //   B — inline `font-size:11px !important`, which genuinely defeats the floor.
  //       The sweep must report it, or the sweep guards nothing.
  const probePriority = await page.evaluate(() => {
    for (const id of ["dec058-floor-probe", "dec058-negative-probe"]) {
      const el = document.createElement("input");
      el.setAttribute("data-testid", id);
      el.style.setProperty("width", "220px");
      el.style.setProperty("height", "32px");
      el.style.setProperty(
        "font-size",
        "11px",
        id === "dec058-negative-probe" ? "important" : "",
      );
      document.body.appendChild(el);
    }
    return document
      .querySelector('[data-testid="dec058-negative-probe"]')
      .style.getPropertyPriority("font-size");
  });
  expect(
    probePriority,
    "the negative probe must keep its !important, otherwise it cannot defeat the floor",
  ).toBe("important");

  const probed = await page.evaluate(sweepScript);
  const floored = probed.controls.find((c) =>
    c.control.includes("dec058-floor-probe"),
  );
  const offender = probed.offenders.find((c) =>
    c.control.includes("dec058-negative-probe"),
  );
  evidence.probes = { floored, offender };
  expect(
    floored?.fontSize,
    "an inline 11px input must be lifted to 16px — this is the proof the DEC-058 coarse-pointer floor is deployed and live",
  ).toBe("16px");
  expect(
    offender,
    "the 16px sweep must report a genuinely sub-16px input, or it proves nothing",
  ).toBeTruthy();
  expect(offender.fontSize).toBe("11px");

  await page.evaluate(() => {
    for (const id of ["dec058-floor-probe", "dec058-negative-probe"])
      document.querySelector(`[data-testid="${id}"]`)?.remove();
  });
  await sweep(page, "room view composer (probes removed)");
  results.push({
    test: "TC-WEB-071 negative probe — the 16px floor is live on production and the sweep can fail",
    status: "passed",
    floored,
    offender,
  });

  // ---------------------------------------------------------------- check 4
  const scaleBefore = await page.evaluate(
    () => window.visualViewport?.scale ?? 1,
  );
  await composer.tap();
  await expect(composer).toBeFocused({ timeout: 30000 });
  await composer.fill("DEC-058 production sweep");
  const focusedFontSize = await composer.evaluate(
    (el) => window.getComputedStyle(el).fontSize,
  );
  const scaleAfter = await page.evaluate(
    () => window.visualViewport?.scale ?? 1,
  );
  evidence.focus = { scaleBefore, scaleAfter, focusedFontSize };
  // toBeCloseTo, not toBe: visualViewport.scale is a float under device
  // emulation and an exact-equality check on it would be a flaky false defect.
  expect(scaleBefore, "page must not be zoomed before focus").toBeCloseTo(1, 3);
  expect(
    scaleAfter,
    "focusing the composer must not zoom the page",
  ).toBeCloseTo(1, 3);
  expect(
    parseFloat(focusedFontSize),
    "composer computed font-size while focused",
  ).toBeGreaterThanOrEqual(16);
  await page.screenshot({ path: shotPath("mobile-04-composer-focused.png") });
  results.push({
    test: "TC-WEB-071 focusing the composer keeps visualViewport.scale at 1 and a >= 16px font-size",
    status: "passed",
    scaleBefore,
    scaleAfter,
    focusedFontSize,
  });
  await composer.fill("");

  // ---------------------------------------------------------------- check 5
  // The 16px floor widened several controls; catch any layout regression it caused.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  evidence.overflow = overflow;
  expect(
    overflow.scrollWidth,
    `room view overflows horizontally at phone width (${overflow.scrollWidth}px content vs ${overflow.innerWidth}px viewport)`,
  ).toBeLessThanOrEqual(overflow.innerWidth + 1);
  results.push({
    test: "TC-WEB-071 room view has no horizontal overflow at phone width",
    status: "passed",
    ...overflow,
  });

  // ---------------------------------------------------------------- check 2d
  await page.goto(base + "/search");
  await expect(page.getByTestId("search-input")).toBeVisible({ timeout: 30000 });
  await sweep(page, "search page");
  await page.screenshot({ path: shotPath("mobile-05-search.png") });

  // ---------------------------------------------------------------- check 2e
  await page.goto(base + "/members");
  await expect(page.getByLabel("Search workspace members")).toBeVisible({ timeout: 30000 });
  await sweep(page, "members page");
  await page.screenshot({ path: shotPath("mobile-06-members.png") });
  results.push({
    test: "TC-WEB-071 search and members page editable controls are all >= 16px",
    status: "passed",
  });

  expect(errors, "uncaught browser errors during the mobile sweep").toEqual([]);
  results.push({
    test: "TC-WEB-071 no uncaught browser errors on the emulated phone",
    status: "passed",
  });
} catch (e) {
  results.push({ status: "failed", error: e.message });
  process.exitCode = 1;
  try {
    await page.screenshot({ path: shotPath("mobile-failure.png") });
  } catch {
    /* page may already be gone */
  }
} finally {
  // Cleanup must run even if the browser is already gone.
  try {
    await browser.close();
  } catch {
    /* browser may have crashed */
  }
  // Scoped teardown: this workspace id AND this run's slug, then only the users
  // that belonged to it and carry this run's prefix. Nothing else is touched.
  let cleanup = "";
  try {
    cleanup = php(
      `$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->first();if($w){$ids=$w->allMemberships()->pluck('user_id');$w->delete();App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();echo 'removed';}else{echo 'already gone';}`,
    ).trim();
  } catch (e) {
    cleanup = "FAILED: " + e.message;
    process.exitCode = 1;
  }
  await writeFile(
    new URL(
      (prod ? "production-" : "") + "mobile-results.json",
      import.meta.url,
    ),
    JSON.stringify(
      {
        requirement: "FR-WEB-001 / DEC-058",
        target: base,
        production: prod,
        device: "iPhone 13 emulation (Chromium, channel=chrome), hasTouch",
        limitations: [
          "Chromium cannot reproduce iOS Safari's real focus auto-zoom; no physical iOS device is driven here.",
          "This proves the DEC-058 CSS floor and viewport meta are LIVE ON PRODUCTION, not the device behaviour itself.",
          "window.visualViewport.scale is trivially 1 in Chromium, so check 4 is a regression tripwire, not evidence of iOS behaviour.",
          "Only the surfaces listed in `surfaces` were swept; controls that render only behind unvisited states are not covered.",
          "`.bc-app` is height:100dvh;overflow:hidden, so the scrollWidth overflow check only catches overflow ESCAPING the app shell — a widened control that overflows inside a clipped pane is not detected.",
          "`expect(errors).toEqual([])` fails on ANY uncaught page error, including benign production noise unrelated to DEC-058; read `errors` before calling it a defect.",
        ],
        fixture,
        results,
        surfaces,
        evidence,
        errors,
        cleanup,
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(JSON.stringify(results, null, 2));
