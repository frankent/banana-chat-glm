# infra/

docker-compose dev/prod services + nginx configs.

## Worker topology (TASK-INF-014, NFR-OPS-011)

All queue work runs through **Horizon** (`php artisan horizon`):

| supervisor | queues | timeout | processes |
|---|---|---|---|
| default | default | 60s | prod 4 / local 1 |
| media | media | 300s | prod 2 |
| push | push | 60s | prod 3 |
| retention | retention | 600s | 1 |
| **ai** | ai | **660s** | `HORIZON_AI_PROCESSES` (default 2, prod 4) |

- `REDIS_QUEUE_RETRY_AFTER=730` (> 660s) so long AI generations are never
  retried while still running.
- Horizon dashboard: `/horizon`, gated to active system admins (same rule
  as the Filament panel, FR-ADM-001).
- Host dev: `make dev-worker` (Horizon) or `make dev-worker-plain`.

## mock-ai (dev / CI / load)

`docker compose up mock-ai` (or `make dev-mock-ai`) — OpenAI-compatible
server on `127.0.0.1:8787` with `GET /v1/models`, `POST /v1/chat/completions`
(stream + non-stream). Create a provider row with
`base_url=http://127.0.0.1:8787/v1` to use it.

Failure injection — env defaults (`MOCK_DELAY_MS`, `MOCK_DELTA_MS`,
`MOCK_STREAM_TOKENS`) or per-request query params:

| knob | effect |
|---|---|
| `?error_1in=N` | every Nth request → HTTP 500 provider error |
| `?status_429_1in=N` | every Nth request → HTTP 429 |
| `?overflow_1in=N` | every Nth request → 400 context_length_exceeded |
| `?trunc_1in=N` | every Nth stream ends without `[DONE]` |
| `?delay_ms=N` | first-token latency (TTFT simulation) |
| `?delta_ms=N` | inter-delta delay (stream pacing) |
| `?stream_tokens=N` | reply length in tokens |

## AI egress allowlist

The API's only allowed external dependency is the AI provider host.
Two enforcement options (spec TASK-INF-014):

1. **Firewall (preferred)** — allow egress 443 only to the provider host
   from the api/worker hosts; everything else denied.
2. **nginx sidecar** — `nginx/ai-egress-allowlist.conf` proxies only
   `/v1/*` to `$AI_PROVIDER_HOST` with a 660s read timeout and SSE-safe
   `proxy_buffering off`; set the provider `base_url` to the proxy.

The SSRF guard in `OpenAiCompatibleProvider` (FR-AI-019) is the
application-level backstop: https-only (production), private-range hosts
refused unless `AI_ALLOW_PRIVATE_HOSTS=true`.

## AI alert rules (NFR-OPS-011)

`ai:check-alerts` runs every 5 minutes (scheduler) and emits structured
`Log::warning` records — `ai.provider_error_rate_alert` (>10% failures in
5 min, min 10 attempts) and `ai.first_token_p95_alert` (p95 > 15s). The
circuit breaker (20 consecutive provider failures → 60s hard pause, sends
answer `503 AI_PROVIDER_ERROR`) is application code, no infra needed.

Routing these logs to Sentry/Slack: set the ops webhook/DSN when
credentials exist and uncomment `Horizon::routeSlackNotificationsTo` in
`HorizonServiceProvider` for queue-lag notifications.

## Load testing (TASK-INF-012)

`infra/k6/chat-load.js` runs three scenarios against a seeded stack
(`make migrate && make seed`):

| scenario | what | threshold |
|---|---|---|
| steady | VUs alternate send (API-040) / history (API-041) | write p95 < 300ms (NFR-PERF-001), read p95 < 200ms (NFR-PERF-002) |
| race | 50 concurrent sends to one room (FR-MEM-001 AC) | unique, gapless seq |
| audit | teardown reads the room tail, verifies the race seq run | `seq_anomalies == 0` |

Run it with the full docker profile (`make up-full`) then:

```sh
make load-test                          # k6 in docker → host.docker.internal:8000
DURATION=45s VUS=8 RACE_VUS=50 make load-test
```

Notes:
- All tokens are minted once in `setup()` (staggered logins) — the login
  limiter is 5/min/IP + 10/15min/username; per-VU logins would 429.
- The race marker is minted in `setup()` too: k6 init code runs per VU,
  so module-level values are not shared with `teardown`.
- Race starts at DURATION+45s so steady has fully ramped down and cannot
  pollute the audited window.
- Nightly CI: `.github/workflows/load-test.yml` (01:23 ICT) or
  `workflow_dispatch` with duration/vus/race_vus inputs.

## Reverb horizontal scaling (TASK-INF-013 / BE-026)

`make up-scale` starts a second Reverb node (`reverb-2`, :8089). Both
nodes subscribe to the Redis pub/sub channel `reverb-scale`
(`REVERB_SCALING_ENABLED=true`), so an event published through either
instance reaches sockets connected to both — verify with
`redis-cli PUBSUB NUMSUB reverb-scale` (= 2).

`nginx/reverb-upstream.conf` is a ready-made sticky (ip_hash) upstream
balancing the two nodes for a production-style front door.
