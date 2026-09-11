import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const require = createRequire(
  new URL("../../../../apps/web/package.json", import.meta.url),
);
const { chromium, expect } = require("@playwright/test");
const root = new URL("../../../../", import.meta.url).pathname;
function php(code) {
  return execFileSync(
    "ssh",
    [
      "-S",
      "/tmp/banana-meeting-ssh",
      "root@165.22.63.119",
      "cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php",
    ],
    {
      cwd: root,
      input: `<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,
      encoding: "utf8",
    },
  );
}
const prefix = "callqa" + Date.now();
const password = randomBytes(20).toString("hex");
const fixture = JSON.parse(
  php(
    `$w=App\\Models\\Workspace::create(['slug'=>'${prefix}','name'=>'Call production QA','status'=>'active']);$users=[];for($i=0;$i<3;$i++){$u=App\\Models\\User::create(['username'=>'${prefix}'.$i,'display_name'=>'Call tester '.($i+1),'password_hash'=>Illuminate\\Support\\Facades\\Hash::make('${password}'),'must_change_password'=>false,'status'=>'active','locale'=>'en']);$w->members()->attach($u->id,['role'=>'member']);$users[]=$u;} $rooms=[];foreach(['dm','group'] as $type){$r=App\\Models\\Room::create(['workspace_id'=>$w->id,'type'=>$type,'name'=>$type==='group'?'Design meeting':null,'created_by'=>$users[0]->id,'member_count'=>$type==='dm'?2:3]);foreach(array_slice($users,0,$type==='dm'?2:3) as $u)$r->members()->attach($u->id,['workspace_id'=>$w->id,'role'=>'member']);$rooms[$type]=$r->id;}echo json_encode(['users'=>array_map(fn($u)=>$u->username,$users),'slug'=>$w->slug,'rooms'=>$rooms,'workspace'=>$w->id]);`,
  ),
);
const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const pages = [],
  contexts = [],
  errors = [],
  results = [],
  credentials = [];
try {
  for (const username of fixture.users) {
    const ctx = await browser.newContext({
      permissions: ["camera", "microphone"],
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
    ctx.on("response", async (res) => {
      if (
        res.request().method() === "POST" &&
        /\/calls\/[^/]+\/join$/.test(new URL(res.url()).pathname) &&
        res.ok()
      ) {
        credentials.push((await res.json()).data);
      }
    });
    const page = await ctx.newPage();
    pages.push(page);
    page.setDefaultTimeout(45000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (["error", "warning"].includes(m.type()))
        console.log(
          "Browser error:",
          m
            .text()
            .replace(/(access_token|join_request)=[^&\s']+/g, "$1=REDACTED"),
        );
    });
    await page.goto("https://chat.gamecoms.net/login");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("aside")).toBeVisible();
  }
  async function nav(page, id) {
    await page.bringToFront();
    await page.evaluate((id) => {
      history.pushState({}, "", `/rooms/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, id);
  }
  async function media(page, kind) {
    await expect
      .poll(
        () =>
          page.evaluate(async (kind) => {
            let total = 0;
            for (const pc of window.__pcs) {
              if (pc.connectionState !== "connected") continue;
              const stats = await pc.getStats();
              stats.forEach((s) => {
                if (s.type === "inbound-rtp" && s.kind === kind)
                  total += s.bytesReceived ?? 0;
              });
            }
            return total;
          }, kind),
        { timeout: 45000 },
      )
      .toBeGreaterThan(1000);
  }
  for (const page of pages.slice(0, 2)) await nav(page, fixture.rooms.dm);
  await pages[0].bringToFront();
  await pages[0].getByRole("button", { name: "Start voice call" }).click();
  await pages[1].bringToFront();
  await pages[1]
    .getByRole("dialog", { name: "Incoming call" })
    .getByRole("button", { name: "Join", exact: true })
    .click();
  await media(pages[0], "audio");
  await media(pages[1], "audio");
  await expect(
    pages[0].locator(".bc-call-stage").getByRole("button", { name: /camera/i }),
  ).toHaveCount(0);
  results.push({
    test: "TC-CALL-008 two-way voice RTP with camera controls absent",
    status: "passed",
  });
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Leave", exact: true })
    .click();
  await expect(pages[1].locator(".bc-call-stage")).toHaveCount(0);
  results.push({
    test: "TC-CALL-004 dm leave disconnects remote",
    status: "passed",
  });
  for (const page of pages) await nav(page, fixture.rooms.group);
  await pages[0].bringToFront();
  await pages[0].getByRole("button", { name: "Start video call" }).click();
  for (const page of pages.slice(1)) {
    await page.bringToFront();
    await page
      .getByRole("dialog", { name: "Incoming call" })
      .getByRole("button", { name: "Join", exact: true })
      .click();
  }
  for (const page of pages) {
    await page.bringToFront();
    await media(page, "video");
    await media(page, "audio");
    await expect(page.locator(".bc-call-count")).toHaveText("3 participants");
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const videos = [
              ...document.querySelectorAll(".bc-call-stage video"),
            ];
            return (
              videos.length === 3 &&
              videos.every(
                (video) => video.videoWidth > 0 && video.readyState >= 2,
              )
            );
          }),
        { timeout: 30000 },
      )
      .toBe(true);
  }
  await pages[0].bringToFront();
  await expect
    .poll(
      () =>
        pages[0].evaluate(() =>
          [...document.querySelectorAll(".bc-call-stage video")].every(
            (video) => video.readyState >= 2,
          ),
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  const selected = await Promise.all(
    pages.map((page) =>
      page.evaluate(async () => {
        const out = [];
        for (const pc of window.__pcs) {
          if (pc.connectionState !== "connected") continue;
          const stats = await pc.getStats();
          for (const t of stats.values())
            if (t.type === "transport" && t.selectedCandidatePairId) {
              const pair = stats.get(t.selectedCandidatePairId);
              const candidate = stats.get(pair.localCandidateId);
              out.push({
                policy: pc.getConfiguration().iceTransportPolicy,
                type: candidate.candidateType,
                relayProtocol: candidate.relayProtocol,
                url: candidate.url,
              });
            }
        }
        return out;
      }),
    ),
  );
  for (const client of selected) {
    expect(client.length).toBeGreaterThan(0);
    for (const candidate of client) {
      expect(candidate.policy).toBe("relay");
      expect(candidate.relayProtocol).toBe("tls");
      expect(candidate.url).toContain("turns:media.gamecoms.net:443");
    }
  }
  results.push({
    test: "TC-CALL-011 three production clients use forced TURN TLS",
    status: "passed",
    selected,
  });
  await pages[0].screenshot({
    path: new URL("private-group-video.png", import.meta.url).pathname,
  });
  results.push({
    test: "TC-CALL-010 three-way video/audio RTP via LiveKit SFU",
    status: "passed",
  });
  await pages[0].bringToFront();
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await expect
    .poll(() =>
      pages[0].evaluate(() =>
        window.__captureTracks
          .filter((t) => t.kind === "audio")
          .every((t) => !t.enabled || t.readyState === "ended"),
      ),
    )
    .toBe(true);
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Share screen", exact: true })
    .click();
  await expect(
    pages[1].locator('[data-lk-source="screen_share"]'),
  ).not.toHaveCount(0);
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Share screen", exact: true })
    .click();
  results.push({
    test: "TC-CALL-008 microphone toggle and synthetic screen share",
    status: "passed",
  });
  await pages[0].setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      pages[0].evaluate(
        () =>
          document.querySelector(".bc-call-stage").getBoundingClientRect()
            .width,
      ),
    )
    .toBeLessThanOrEqual(390);
  await pages[0].screenshot({
    path: new URL("private-mobile-video.png", import.meta.url).pathname,
  });
  await pages[0].setViewportSize({ width: 1440, height: 900 });
  results.push({ test: "TC-CALL-008 mobile call layout", status: "passed" });
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Minimize call" })
    .click();
  await nav(pages[0], fixture.rooms.dm);
  await media(pages[0], "video");
  results.push({
    test: "TC-CALL-009 call survives navigation",
    status: "passed",
  });
  php(
    `$u=App\\Models\\User::where('username','${fixture.users[2]}')->firstOrFail();App\\Models\\RoomMember::where('room_id','${fixture.rooms.group}')->where('user_id',$u->id)->update(['left_at'=>now()]);app()->call([new App\\Jobs\\ReconcileCalls,'handle']);`,
  );
  await expect(pages[2].locator(".bc-call-stage")).toHaveCount(0);
  results.push({
    test: "TC-CALL-007 SFU removes a revoked room member",
    status: "passed",
  });
  await pages[1]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Leave", exact: true })
    .click();
  await expect(pages[0].locator(".bc-call-count")).toHaveText("1 participant");
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "End for everyone" })
    .click();
  await expect(pages[2].locator(".bc-call-stage")).toHaveCount(0);
  results.push({
    test: "TC-CALL-004 group continues after leave and starter ends all",
    status: "passed",
  });
  for (const page of pages)
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__captureTracks.every((t) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
  results.push({
    test: "TC-CALL-009 every captured track stops after leaving",
    status: "passed",
  });
  await pages[0].bringToFront();
  await pages[0].evaluate(() => {
    window.__denyMedia = true;
  });
  await pages[0].getByRole("button", { name: "Start video call" }).click();
  await expect(pages[0].locator('.bc-call-stage [role="alert"]')).toContainText(
    "Allow camera/microphone",
  );
  await pages[0].evaluate(() => {
    window.__denyMedia = false;
  });
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Microphone", exact: true })
    .click();
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Camera", exact: true })
    .click();
  await pages[1].bringToFront();
  await pages[1]
    .getByRole("dialog", { name: "Incoming call" })
    .getByRole("button", { name: "Join", exact: true })
    .click();
  await media(pages[0], "video");
  await media(pages[1], "video");
  await expect(pages[0].locator('.bc-call-stage [role="alert"]')).toHaveCount(
    0,
  );
  results.push({
    test: "TC-CALL-008 dm video and simulated permission-error recovery",
    status: "passed",
  });
  await pages[0].bringToFront();
  await pages[0]
    .locator(".bc-call-stage")
    .getByRole("button", { name: "Minimize call" })
    .click();
  const logoutResponse = pages[0].waitForResponse(
    (r) => r.url().endsWith("/auth/logout") && r.request().method() === "POST",
  );
  await pages[0].getByRole("button", { name: "Sign out", exact: true }).click();
  await logoutResponse;
  await expect(pages[0]).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      pages[0].evaluate(() =>
        window.__captureTracks.every((t) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
  php(`app()->call([new App\\Jobs\\ReconcileCalls,'handle']);`);
  await expect(pages[1].locator(".bc-call-stage")).toHaveCount(0);
  results.push({
    test: "TC-CALL-009 logout releases devices and revoked session ends dm",
    status: "passed",
  });
  for (const credential of credentials) {
    const gate = await fetch("https://chat.gamecoms.net/rtc", {
      headers: { Authorization: "Bearer " + credential.token },
    });
    expect([401, 403]).toContain(gate.status);
  }
  results.push({
    test: "TC-CALL-005 production nginx gate rejects ended call credentials",
    status: "passed",
  });
  if (errors.length) throw Error(errors.join("\n"));
  results.push({
    test: "TC-CALL-008 no JavaScript runtime errors",
    status: "passed",
  });
} catch (e) {
  for (const p of pages)
    results.push({
      diagnostic: await p.evaluate(async () =>
        Promise.all(
          window.__pcs.map(async (pc) => ({
            connection: pc.connectionState,
            ice: pc.iceConnectionState,
            signaling: pc.signalingState,
            events: window.__iceEvents,
            media: window.__mediaEvents,
            stats: [...(await pc.getStats()).values()]
              .filter((s) =>
                [
                  "candidate-pair",
                  "local-candidate",
                  "remote-candidate",
                  "inbound-rtp",
                  "outbound-rtp",
                ].includes(s.type),
              )
              .map((s) => ({
                type: s.type,
                state: s.state,
                kind: s.kind,
                address: s.address,
                port: s.port,
                protocol: s.protocol,
                bytesReceived: s.bytesReceived,
                bytesSent: s.bytesSent,
              })),
          })),
        ),
      ),
    });
  results.push({ status: "failed", error: e.message });
  if (pages[0])
    await pages[0].screenshot({
      path: new URL("private-failure.png", import.meta.url).pathname,
    });
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL("private-calls-results.json", import.meta.url),
    JSON.stringify({ fixture, results, errors }, null, 2),
  );
  for (const c of contexts) await c.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
  php(
    `$w=App\\Models\\Workspace::where('id','${fixture.workspace}')->where('slug','${prefix}')->firstOrFail();foreach(App\\Models\\RoomCall::where('workspace_id',$w->id)->whereNull('ended_at')->get() as $c)app(App\\Domain\\Calls\\CallService::class)->end($c);$ids=$w->allMemberships()->pluck('user_id');$w->delete();App\\Models\\User::whereIn('id',$ids)->where('username','like','${prefix}%')->delete();echo 'QA workspace and users removed';`,
  );
}
console.log(JSON.stringify(results, null, 2));
