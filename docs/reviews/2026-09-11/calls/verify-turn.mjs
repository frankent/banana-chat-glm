import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const root = process.cwd();
const require = createRequire(root + "/apps/web/package.json");
const { chromium, expect } = require("@playwright/test");
const room = "turn-qa-" + Date.now();
function php(code) {
  return execFileSync(
    "ssh",
    [
      "-S",
      "/tmp/banana-calls-ssh",
      "root@165.22.63.119",
      "cd /opt/banana-chat && docker compose --env-file infra/.env -f infra/docker-compose.prod.yml exec -T api php",
    ],
    {
      input: `<?php require '/app/vendor/autoload.php';$app=require '/app/bootstrap/app.php';$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();${code}`,
      encoding: "utf8",
    },
  );
}
const credentials = JSON.parse(
  php(
    `$m=app(App\\Domain\\Calls\\MediaServer::class);$m->request('CreateRoom','${room}',['name'=>'${room}','max_participants'=>2]);echo json_encode(array_map(fn($id)=>$m->token(['sub'=>$id,'video'=>['roomJoin'=>true,'room'=>'${room}','canPublish'=>true,'canSubscribe'=>true]]),['relay1','relay2']));`,
  ),
);
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const pages = [];
try {
  for (const token of credentials) {
    const page = await browser.newPage();
    pages.push(page);
    await page.goto("http://127.0.0.1:5173/login");
    await page.evaluate(async (token) => {
      const { Room } = await import(
        "/node_modules/.vite/deps/livekit-client.js"
      );
      const Original = window.RTCPeerConnection;
      window.__pcs = [];
      window.__configs = [];
      window.__iceErrors = [];
      window.__candidates = [];
      window.__states = [];
      function force(config) {
        window.__configs.push((config.iceServers ?? []).map((s) => s.urls));
        const servers = (config.iceServers ?? []).flatMap((s) => {
          const urls = [s.urls].flat().filter((u) => u.startsWith("turns:"));
          return urls.length ? [{ ...s, urls }] : [];
        });
        return { ...config, iceTransportPolicy: "relay", iceServers: servers };
      }
      window.RTCPeerConnection = class extends Original {
        constructor(config, ...args) {
          super(force(config), ...args);
          window.__pcs.push(this);
          this.addEventListener("icecandidate", (e) => {
            if (e.candidate)
              window.__candidates.push({
                type: e.candidate.type,
                protocol: e.candidate.protocol,
                address: e.candidate.address,
                port: e.candidate.port,
              });
          });
          this.addEventListener("icegatheringstatechange", () =>
            window.__states.push(this.iceGatheringState),
          );
          this.addEventListener("icecandidateerror", (e) =>
            window.__iceErrors.push({
              url: e.url,
              errorCode: e.errorCode,
              errorText: e.errorText,
            }),
          );
        }
        setConfiguration(config) {
          super.setConfiguration(force(config));
        }
      };
      const room = new Room();
      window.__room = room;
      await room.connect("ws://127.0.0.1:17880", token);
      const ac = new AudioContext();
      await ac.resume();
      window.__audio = ac;
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      await room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0]);
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      window.__timer = setInterval(() => {
        const c = canvas.getContext("2d");
        c.fillStyle = "green";
        c.fillRect(0, 0, 320, 180);
        c.fillStyle = "white";
        c.fillText(String(Date.now()), 20, 40);
      }, 100);
      await room.localParticipant.publishTrack(
        canvas.captureStream(10).getVideoTracks()[0],
      );
    }, token);
  }
  const checks = [];
  for (const page of pages) {
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const sum = { audio: 0, video: 0 };
            for (const pc of window.__pcs) {
              for (const s of (await pc.getStats()).values())
                if (s.type === "inbound-rtp")
                  sum[s.kind] += s.bytesReceived ?? 0;
            }
            return Math.min(sum.audio, sum.video);
          }),
        { timeout: 45000 },
      )
      .toBeGreaterThan(1000);
    const selected = await page.evaluate(async () => {
      const found = [];
      for (const pc of window.__pcs) {
        const stats = await pc.getStats();
        for (const t of stats.values())
          if (t.type === "transport" && t.selectedCandidatePairId) {
            const pair = stats.get(t.selectedCandidatePairId);
            const c = stats.get(pair.localCandidateId);
            found.push({
              iceTransportPolicy: pc.getConfiguration().iceTransportPolicy,
              candidateType: c.candidateType,
              protocol: c.protocol,
              relayProtocol: c.relayProtocol,
              url: c.url,
              bytesReceived: pair.bytesReceived,
              bytesSent: pair.bytesSent,
            });
          }
      }
      return found;
    });
    expect(selected.length).toBeGreaterThan(0);
    for (const c of selected) {
      expect(["relay", "prflx"]).toContain(c.candidateType);
      expect(c.iceTransportPolicy).toBe("relay");
      expect(c.relayProtocol).toBe("tls");
      expect(c.url).toContain("media.gamecoms.net:443");
    }
    checks.push(selected);
  }
  const result = {
    test: "TC-CALL-011 forced TURN TLS 443 bidirectional audio/video RTP",
    status: "passed",
    capture: "synthetic",
    selected: checks,
  };
  writeFileSync(
    root + "/docs/reviews/2026-09-11/calls/turn-relay.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  for (const p of pages)
    console.log(
      JSON.stringify(
        await p.evaluate(async () => ({
          configs: window.__configs,
          candidates: window.__candidates,
          states: window.__states,
          errors: window.__iceErrors,
          stats: await Promise.all(
            (window.__pcs ?? []).map(async (pc) =>
              [...(await pc.getStats()).values()]
                .filter((s) => s.type.includes("candidate"))
                .map((s) => ({
                  type: s.type,
                  candidateType: s.candidateType,
                  url: s.url,
                  relayProtocol: s.relayProtocol,
                  state: s.state,
                  bytesSent: s.bytesSent,
                  bytesReceived: s.bytesReceived,
                })),
            ),
          ),
        })),
        null,
        2,
      ),
    );
  throw e;
} finally {
  await browser.close();
  php(
    `app(App\\Domain\\Calls\\MediaServer::class)->request('DeleteRoom','${room}',['room'=>'${room}']);`,
  );
}
