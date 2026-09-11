import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
const root = new URL("../../../../", import.meta.url).pathname;
const require = createRequire(root + "apps/web/package.json");
const { chromium, expect } = require("@playwright/test");
const prod = process.env.MEETING_QA_PRODUCTION === "1";
const base = prod ? "https://chat.gamecoms.net" : "http://127.0.0.1:5173";
const gate = prod ? base : "http://localhost:18880";
function php(code) {
  return execFileSync(
    prod ? "ssh" : "docker",
    prod
      ? [
          "-S",
          "/tmp/banana-meeting-ssh",
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
const prefix = "meetqa" + Date.now();
const password = randomBytes(20).toString("hex");
const fixture = JSON.parse(
  php(
    `$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Meeting QA','status'=>'active']);$users=[];foreach(['Morgan Host','Jordan Member'] as $i=>$name){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>$name,'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'member']);$users[]=$u->username;}echo json_encode(['workspace'=>$w->id,'slug'=>$w->slug,'users'=>$users]);`,
  ),
);
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const pages = [],
  contexts = [],
  results = [],
  errors = [],
  credentials = [];
let memberAccess = "";
async function context() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    // Synthetic capture only; RTP transport and subscriptions use the real SFU.
    window.__captureTracks = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (window.__denyMedia)
        throw new DOMException("Permission denied", "NotAllowedError");
      const tracks = [];
      if (constraints.audio) {
        const ac = new AudioContext();
        await ac.resume();
        const source = ac.createOscillator();
        source.frequency.value = 440;
        const dest = ac.createMediaStreamDestination();
        source.connect(dest);
        source.start();
        const track = dest.stream.getAudioTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState === "ended") return;
          stop();
          source.stop();
          void ac.close();
        };
        tracks.push(track);
      }
      if (constraints.video) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const paint = () => {
          const c = canvas.getContext("2d");
          c.fillStyle = "#294957";
          c.fillRect(0, 0, 640, 360);
          c.fillStyle = "#f6d66c";
          c.font = "28px sans-serif";
          c.fillText("Banana Chat · Media QA", 50, 145);
          c.fillText(new Date().toISOString().slice(11, 23), 50, 200);
        };
        paint();
        const timer = setInterval(paint, 100);
        const track = canvas.captureStream(10).getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState === "ended") return;
          stop();
          clearInterval(timer);
        };
        tracks.push(track);
      }
      window.__captureTracks.push(...tracks);
      return new MediaStream(tracks);
    };
    navigator.mediaDevices.getDisplayMedia = () =>
      navigator.mediaDevices.getUserMedia({ video: true });
    window.__pcs = [];
    window.__iceEvents = [];
    window.__mediaEvents = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async function (c) {
      window.__mediaEvents.push({
        step: "request",
        visibility: document.visibilityState,
      });
      try {
        const stream = await getMedia(c);
        window.__mediaEvents.push({
          step: "result",
          tracks: stream.getTracks().map((t) => ({
            kind: t.kind,
            state: t.readyState,
            enabled: t.enabled,
          })),
        });
        return stream;
      } catch (e) {
        window.__mediaEvents.push({ step: "error", name: e.name });
        throw e;
      }
    };
    // TC-CALL-011: force TLS TURN for every production UI call.
    const forceRelay = (config) => ({
      ...config,
      iceTransportPolicy: "relay",
      iceServers: (config.iceServers ?? []).flatMap((server) => {
        const urls = [server.urls]
          .flat()
          .filter((url) => url.startsWith("turns:"));
        return urls.length ? [{ ...server, urls }] : [];
      }),
    });
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original {
      constructor(config, ...args) {
        super(forceRelay(config), ...args);
        window.__pcs.push(this);
        this.addEventListener("iceconnectionstatechange", () =>
          window.__iceEvents.push({
            state: this.iceConnectionState,
            remoteCandidates: this.remoteDescription?.sdp
              .split("\r\n")
              .filter((l) => l.startsWith("a=candidate:")),
          }),
        );
      }
      setConfiguration(config) {
        super.setConfiguration(forceRelay(config));
      }
    };
  });

  if (!prod)
    await ctx.route(/\/(api|broadcasting)\//, async (route) => {
      const target = new URL(route.request().url());
      target.host = "localhost:18000";
      try {
        const res = await route.fetch({ url: target.toString() });
        await route.fulfill({ response: res });
      } catch (e) {
        if (!/closed|disposed/.test(e.message)) throw e;
      }
    });
  const page = await ctx.newPage();
  pages.push(page);
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (res) => {
    if (
      res.request().method() === "POST" &&
      /\/public-meetings\/[^/]+\/join$/.test(new URL(res.url()).pathname) &&
      res.ok()
    )
      credentials.push((await res.json()).data);
  });
  return page;
}
async function media(page) {
  await page.bringToFront();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const totals = { audio: 0, video: 0 };
          for (const pc of window.__pcs) {
            if (pc.connectionState !== "connected") continue;
            for (const s of (await pc.getStats()).values())
              if (s.type === "inbound-rtp")
                totals[s.kind] += s.bytesReceived ?? 0;
          }
          return Math.min(totals.audio, totals.video);
        }),
      { timeout: 45000 },
    )
    .toBeGreaterThan(1000);
}
try {
  const host = await context(),
    member = await context(),
    guest = await context();
  for (const [index, page] of [host].entries()) {
    if (index === 1)
      page.on("response", async (r) => {
        if (r.url().endsWith("/auth/login") && r.ok())
          memberAccess = (await r.json()).access_token;
      });
    await page.goto(base + "/login");
    await page.getByLabel("Username").fill(fixture.users[index]);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("aside")).toBeVisible();
  }
  await host.getByRole("button", { name: "Meetings", exact: true }).click();
  await host.getByLabel("Meeting name").fill("Partner design review");
  await host.getByRole("button", { name: "Create meeting" }).click();
  const input = host.getByRole("textbox", {
    name: "Meeting link for Partner design review",
  });
  await expect(input).toBeVisible();
  const link = await input.inputValue();
  expect(link).toMatch(/\/meet\/[a-f0-9]{64}$/);
  results.push({
    test: "TC-MEET-001 create public meeting from workspace UI",
    status: "passed",
  });
  await guest.goto(link);
  await expect(guest.getByLabel("Your name")).toBeVisible();
  await guest.getByLabel("Your name").fill("   ");
  await expect(
    guest.getByRole("button", { name: "Join meeting", exact: true }),
  ).toBeDisabled();
  await guest.getByLabel("Your name").fill("Alex Partner");
  await guest.screenshot({
    path: new URL(
      (prod ? "production-" : "") + "guest-lobby.png",
      import.meta.url,
    ).pathname,
  });
  await host.goto(link);
  await member.goto(link);
  member.on("response", async (r) => {
    if (r.url().endsWith("/auth/login") && r.ok())
      memberAccess = (await r.json()).access_token;
  });
  await member.getByRole("link", { name: "Sign in as a member" }).click();
  await member.getByLabel("Username").fill(fixture.users[1]);
  await member.getByLabel("Password").fill(password);
  await member.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(member).toHaveURL(link);
  results.push({
    test: "TC-MEET-010 member login returns to the shared meeting link",
    status: "passed",
  });
  await expect(host.getByText("Morgan Host", { exact: true })).toBeVisible();
  await expect(
    member.getByText("Jordan Member", { exact: true }),
  ).toBeVisible();
  await expect(host.getByLabel("Your name")).toHaveCount(0);
  results.push({
    test: "TC-MEET-002/003 member detection and required guest name",
    status: "passed",
  });
  for (const page of [host, guest, member]) {
    await page.bringToFront();
    await page
      .getByRole("button", { name: "Join meeting", exact: true })
      .click();
    await expect(page.locator(".bc-call-stage")).toBeVisible();
  }
  for (const page of [host, guest, member]) {
    await media(page);
    await expect(page.locator(".bc-call-count")).toHaveText("3 participants");
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const vs = [...document.querySelectorAll(".bc-call-stage video")];
            return (
              vs.length === 3 &&
              vs.every((v) => v.videoWidth > 0 && v.readyState >= 2)
            );
          }),
        { timeout: 30000 },
      )
      .toBe(true);
    await expect(
      page
        .locator(".bc-call-stage")
        .getByText("Alex Partner (Guest)", { exact: true }),
    ).toBeVisible();
  }
  await expect(
    guest.getByRole("button", { name: "End for everyone" }),
  ).toHaveCount(0);
  await expect(
    member.getByRole("button", { name: "End for everyone" }),
  ).toHaveCount(0);
  const selected = await Promise.all(
    [host, guest, member].map((p) =>
      p.evaluate(async () => {
        const out = [];
        for (const pc of window.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const stats = await pc.getStats();
          for (const t of stats.values())
            if (t.type === "transport" && t.selectedCandidatePairId) {
              const pair = stats.get(t.selectedCandidatePairId);
              const c = stats.get(pair.localCandidateId);
              out.push({
                policy: pc.getConfiguration().iceTransportPolicy,
                relayProtocol: c.relayProtocol,
                url: c.url,
              });
            }
        }
        return out;
      }),
    ),
  );
  for (const client of selected) {
    expect(client.length).toBeGreaterThan(0);
    for (const c of client) {
      expect(c.policy).toBe("relay");
      expect(c.relayProtocol).toBe("tls");
      expect(c.url).toContain("media.gamecoms.net:443");
    }
  }
  results.push({
    test: "TC-MEET-010 three-way member/guest audio/video over forced TURN TLS",
    status: "passed",
    selected,
  });
  await host.bringToFront();
  await expect
    .poll(
      () =>
        host.evaluate(() =>
          [...document.querySelectorAll(".bc-call-stage video")].every(
            (v) => v.readyState >= 2,
          ),
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await host.screenshot({
    path: new URL((prod ? "production-" : "") + "meeting.png", import.meta.url)
      .pathname,
  });
  await guest.bringToFront();
  await guest.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      guest.evaluate(
        () =>
          document.querySelector(".bc-call-stage").getBoundingClientRect()
            .width,
      ),
    )
    .toBeLessThanOrEqual(390);
  await guest.screenshot({
    path: new URL(
      (prod ? "production-" : "") + "mobile-meeting.png",
      import.meta.url,
    ).pathname,
  });
  await guest.setViewportSize({ width: 1440, height: 900 });
  await guest.getByRole("button", { name: "Microphone", exact: true }).click();
  await expect
    .poll(() =>
      guest.evaluate(() =>
        window.__captureTracks
          .filter((t) => t.kind === "audio")
          .every((t) => !t.enabled || t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await guest.getByRole("button", { name: "Microphone", exact: true }).click();
  await host.bringToFront();
  await host.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    guest.locator('[data-lk-source="screen_share"]'),
  ).not.toHaveCount(0);
  await host.getByRole("button", { name: "Share screen", exact: true }).click();
  results.push({
    test: "TC-MEET-010 mobile layout, microphone toggle and screen share",
    status: "passed",
  });
  // Revoke only the member's QA session; the public meeting must continue.
  expect(memberAccess).not.toBe("");
  const loggedOut = await member.request.post(
    (prod ? base : "http://localhost:18000") + "/api/v1/auth/logout",
    {
      headers: {
        Authorization: "Bearer " + memberAccess,
        Accept: "application/json",
      },
    },
  );
  expect(loggedOut.ok()).toBe(true);
  if (!prod) php(`app()->call([new App\\Jobs\\ReconcileMeetings,'handle']);`);
  await expect(member.locator(".bc-call-stage")).toHaveCount(0);
  await expect(host.locator(".bc-call-count")).toHaveText("2 participants");
  results.push({
    test: "TC-MEET-008 member logout evicts only that participant",
    status: "passed",
  });
  await guest.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(guest.locator(".bc-call-stage")).toHaveCount(0);
  await expect
    .poll(() =>
      guest.evaluate(() =>
        window.__captureTracks.every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await expect(host.locator(".bc-call-count")).toHaveText("1 participant");
  await guest
    .getByRole("button", { name: "Join meeting", exact: true })
    .click();
  await media(guest);
  await expect(host.locator(".bc-call-count")).toHaveText("2 participants");
  results.push({
    test: "TC-MEET-005 guest leave releases devices and link remains reusable",
    status: "passed",
  });
  await host.getByRole("button", { name: "End for everyone" }).click();
  await expect(host.locator(".bc-call-stage")).toHaveCount(0);
  await expect(guest.locator(".bc-call-stage")).toHaveCount(0);
  await guest.reload();
  await expect(guest.getByRole("alert")).toContainText("expired or was ended");
  await expect(
    guest.getByRole("button", { name: "Join meeting", exact: true }),
  ).toHaveCount(0);
  for (const credential of credentials) {
    const res = await fetch(gate + "/rtc", {
      headers: { Authorization: "Bearer " + credential.token },
    });
    expect([401, 403]).toContain(res.status);
  }
  results.push({
    test: "TC-MEET-007 creator end revokes link and media credentials for all",
    status: "passed",
  });
  expect(errors).toEqual([]);
  results.push({
    test: "TC-MEET-010 no uncaught browser errors",
    status: "passed",
  });
} catch (e) {
  results.push({ status: "failed", error: e.message });
  if (pages[0])
    await pages[0].screenshot({
      path: new URL("failure.png", import.meta.url).pathname,
    });
  process.exitCode = 1;
} finally {
  await browser.close();
  php(
    `$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->firstOrFail();foreach(App\\Models\\Meeting::where('workspace_id',$w->id)->get() as $m)app(App\\Domain\\Calls\\MeetingService::class)->end($m);$ids=$w->allMemberships()->pluck('user_id');$w->delete();App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();`,
  );
  await writeFile(
    new URL((prod ? "production-" : "") + "results.json", import.meta.url),
    JSON.stringify({ fixture, results, errors, cleanup: true }, null, 2) + "\n",
  );
}
console.log(JSON.stringify(results, null, 2));
