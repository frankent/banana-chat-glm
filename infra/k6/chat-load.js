import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import exec from 'k6/execution';

/**
 * TASK-INF-012 / TASK-BE-026 — k6 load suite against a seeded stack
 * (`make migrate && make seed`, spec demo users/workspace).
 *
 * Scenarios
 *   steady  — VUs alternate write (API-040) / read (API-041) in the seeded
 *             Engineering room; pacing respects the api limiter (300/min/user)
 *             and login throttling (5/min/IP, 10/15min/username → one token
 *             per VU, rotating the four seeded users).
 *   race    — RACE_VUS (default 50) single-shot sends to the same room; the
 *             FR-MSG-001 AC "seq ต่อห้องไม่ซ้ำและไม่ข้าม แม้ส่งพร้อมกัน 50 request".
 *   audit   — after race: reads the room tail, verifies the 50 race messages
 *             have unique + consecutive seqs (counter seq_anomalies must be 0).
 *
 * Thresholds: write p95 < 300ms (NFR-PERF-001), read p95 < 200ms
 * (NFR-PERF-002), http_req_failed < 1%, seq_anomalies == 0.
 *
 * Run:  make load-test                    # k6 in docker, TARGET=host.docker.internal:8000
 *       k6 run -e TARGET=http://localhost:8000 -e DURATION=30s infra/k6/chat-load.js
 */

const TARGET = __ENV.TARGET || 'http://localhost:8000';
const WORKSPACE = __ENV.WORKSPACE || 'acme';
const ROOM_NAME = __ENV.ROOM || 'Engineering';
const DURATION = __ENV.DURATION || '2m';
const VUS = parseInt(__ENV.VUS || '8', 10);
const RACE_VUS = parseInt(__ENV.RACE_VUS || '50', 10);
/** seeded demo users (DatabaseSeeder) — keeps every VU under the login limiter */
const USERS = (__ENV.USERS || 'tony:Tony12345!,anna:Anna12345!,somchai:Somchai12345!,duangjai:Duangjai12345!')
  .split(',')
  .map((pair) => {
    const [username, password] = pair.split(':');
    return { username, password };
  });

const writeLatency = new Trend('write_latency', true);
const readLatency = new Trend('read_latency', true);
const seqAnomalies = new Counter('seq_anomalies');

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
      exec: 'steady',
    },
    race: {
      executor: 'per-vu-iterations',
      vus: RACE_VUS,
      iterations: 1,
      // steady needs 15s ramp-up + DURATION + 10s ramp-down (+5s graceful)
      // to fully stop; +45s clears it so no steady write can land after the
      // race batch (teardown only reads the newest 100 rows)
      startTime: `${DURATION}`.endsWith('m')
        ? `${parseInt(DURATION, 10) * 60 + 45}s`
        : `${parseInt(DURATION, 10) + 45}s`,
      maxDuration: '2m',
      exec: 'race',
    },
  },
  thresholds: {
    write_latency: ['p(95)<300'], // NFR-PERF-001
    read_latency: ['p(95)<200'], // NFR-PERF-002
    seq_anomalies: ['count==0'], // FR-MSG-001 AC (50 concurrent sends)
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const wsHeaders = { 'X-Workspace-Id': WORKSPACE };
/** steady-scenario body marker only (cosmetic); the race marker is minted in
 * setup() — a module-level value would be re-created per VU (each VU runs its
 * own init copy) and the teardown audit would filter on a marker nobody sent */
const runId = Date.now().toString(36);

/** RFC-4122-shaped uuid from Math.random (Laravel `uuid` rule checks format) */
function uuid() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

function login(user) {
  const res = http.post(`${TARGET}/api/v1/auth/login`, JSON.stringify({
    username: user.username,
    password: user.password,
  }), { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } });
  check(res, { 'login 200': (r) => r.status === 200 });
  return res.json('access_token'); // auth endpoints are bare (§7: no data envelope)
}

/**
 * All tokens are minted in setup() — FR-AUTH-006 throttles login at 5/min/IP
 * + 10/15min/username, so per-VU logins (50 race VUs!) would 429. Setup
 * staggers the logins (12s apart → ≤4 per rolling minute) and every scenario
 * reuses them; per-user send volume stays under the 300/min api limiter.
 */
function tokenFor(data, index) {
  return data.tokens[index % data.tokens.length];
}

export function setup() {
  const tokens = [];
  for (const user of USERS) {
    const token = login(user);
    if (token === undefined || token === null) {
      exec.test.abort(`login failed for ${user.username} — is the stack seeded? (make migrate && make seed)`);
    }
    tokens.push(token);
    sleep(12);
  }

  const res = http.get(`${TARGET}/api/v1/rooms`, {
    headers: { Authorization: `Bearer ${tokens[0]}`, ...wsHeaders },
    tags: { name: 'rooms' },
  });
  const rooms = res.json('data') || [];
  const room = rooms.find((r) => r.room && r.room.name === ROOM_NAME);
  if (room === undefined) {
    exec.test.abort(`room "${ROOM_NAME}" not found — run make migrate && make seed first`);
  }
  // minted once here — setup() runs a single time and its return value is
  // shared with every VU + teardown as `data`, so all race bodies carry the
  // exact marker the audit filters on
  const raceMarker = `k6-race-${Date.now().toString(36)}`;
  return { roomId: room.room.id, tokens, raceMarker };
}

export function steady(data) {
  const auth = { Authorization: `Bearer ${tokenFor(data, exec.vu.idInTest)}`, ...wsHeaders, 'Content-Type': 'application/json' };

  const send = http.post(
    `${TARGET}/api/v1/rooms/${data.roomId}/messages`,
    JSON.stringify({ body: `k6 steady ${runId} vu${exec.vu.idInTest}`, client_message_id: uuid() }),
    { headers: auth, tags: { name: 'send' } },
  );
  writeLatency.add(send.timings.duration);
  check(send, { 'send 2xx': (r) => r.status >= 200 && r.status < 300 });
  if (send.status < 200 || send.status >= 300) {
    console.log(`steady vu${exec.vu.idInTest} send → ${send.status}: ${send.body.slice(0, 160)}`);
  }

  const page = http.get(`${TARGET}/api/v1/rooms/${data.roomId}/messages?limit=50`, {
    headers: auth,
    tags: { name: 'history' },
  });
  readLatency.add(page.timings.duration);
  check(page, { 'history 200': (r) => r.status === 200 });
  if (page.status !== 200) {
    console.log(`steady vu${exec.vu.idInTest} history → ${page.status}: ${page.body.slice(0, 160)}`);
  }

  // 2 req/iter × ~2 VUs/user: keep each user ≤~160/min (api limiter is 300/min)
  sleep(Math.random() * 1.5 + 1.2);
}

export function race(data) {
  const auth = { Authorization: `Bearer ${tokenFor(data, exec.vu.idInTest)}`, ...wsHeaders, 'Content-Type': 'application/json' };
  const res = http.post(
    `${TARGET}/api/v1/rooms/${data.roomId}/messages`,
    JSON.stringify({ body: `${data.raceMarker} vu${exec.vu.idInTest}`, client_message_id: uuid() }),
    { headers: auth, tags: { name: 'race_send' } },
  );
  check(res, { 'race send 2xx': (r) => r.status >= 200 && r.status < 300 });
  if (res.status < 200 || res.status >= 300) {
    console.log(`race vu${exec.vu.idInTest} → ${res.status}: ${res.body.slice(0, 160)}`);
  }
}

export function teardown(data) {
  // FR-MSG-001 audit — the 50 race messages must be one unique, gapless seq run
  const auth = { Authorization: `Bearer ${tokenFor(data, 1)}`, ...wsHeaders };
  const page = http.get(`${TARGET}/api/v1/rooms/${data.roomId}/messages?limit=100`, {
    headers: auth,
    tags: { name: 'audit' },
  });
  const messages = (page.json('data.messages') || []).filter(
    (m) => typeof m.body === 'string' && m.body.startsWith(data.raceMarker),
  );

  if (messages.length !== RACE_VUS) {
    console.log(`audit: got ${messages.length}/${RACE_VUS} (page ${page.status})`);
    seqAnomalies.add(Math.abs(RACE_VUS - messages.length)); // lost or unflushed rows
    return;
  }
  const seqs = messages.map((m) => m.seq).sort((a, b) => a - b);
  for (let i = 1; i < seqs.length; i += 1) {
    const gap = seqs[i] - seqs[i - 1];
    if (gap !== 1) {
      seqAnomalies.add(1); // duplicate (0) or skipped (>1) seq
    }
  }
}
