# infra/

docker-compose dev/staging/prod services + nginx configs.

## Production stack (TASK-INF-002/003, DEC-044)

`docker-compose.prod.yml` is the self-hosted prod topology — one nginx edge
(`infra/nginx/Dockerfile` bakes the built web SPA into it) in front of
php-fpm api, Horizon worker, scheduler, Reverb, plus bundled
postgres/redis/minio/clamav. Nothing stateful publishes a port; only the
edge (`${HTTP_PORT:-80}`) and the MinIO console (localhost-only :9101) are
reachable.

First run — the installer (DEC-043) drives it:

```sh
touch apps/api/.env                     # bind-mounted into every app service —
                                        # must exist BEFORE `up` or Docker
                                        # mounts a directory over /app/.env
docker compose -f infra/docker-compose.prod.yml up -d --build
# open http://<host>/setup → fill PostgreSQL/Redis/SMTP creds + admin
docker compose -f infra/docker-compose.prod.yml restart worker scheduler reverb
```

The long-running services (worker/scheduler/reverb) boot before `.env`
exists and crash-loop harmlessly (restart policy) until the wizard writes
it — that final `restart` makes them pick it up. The api (fpm) needs no
restart: it re-reads `.env` per request (no config cache is baked, on
purpose — DEC-044).

### Linux host notes (from the first real deploy)

- `touch apps/api/.env` creates a **root-owned** file — php-fpm runs as
  www-data (uid 82 in alpine), so the installer's `.env` write 500s with
  nothing in the log (the logging failure masks it). After touching:
  `chown 82:82 apps/api/.env`.
- worker/scheduler/reverb run artisan as **root** while fpm runs as
  www-data: root creates `storage/logs/laravel.log` first and www-data can
  no longer append. After the first boot, once:
  `docker compose -f infra/docker-compose.prod.yml exec api sh -c 'chown -R 82:82 /app/storage'`.
- Cloud droplets generally **cannot reach their own public IP** (no
  hairpin NAT): keep `AWS_ENDPOINT` container-direct (default) until the
  edge hostname actually serves TLS, then flip it to
  `https://<host>/storage` for browser-fetchable presigned URLs.

### Deploy-specific values (environment or `infra/.env`)

`cp infra/.env.example infra/.env` documents every knob below with its
default; `make up-prod` / `make up-staging` pass it via `--env-file`
automatically when it exists.

| var | default | what |
|---|---|---|
| `VITE_REVERB_HOST` | `localhost` | public hostname — **baked into the web build**; set it, then `build nginx` |
| `VITE_REVERB_PORT` / `VITE_REVERB_SCHEME` | `80` / `http` | ws port/scheme through the edge |
| `HTTP_PORT` | `80` | edge listen port |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `orgchat` ×3 | bundled postgres creds (type the same into the installer) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `orgchat` / `orgchat123` | MinIO (also feeds the api's AWS keys) |
| `AWS_ENDPOINT` | `http://minio:9000` | container-direct uploads. Set `http://<host>/storage` to make presigned attachment URLs browser-fetchable — the `/storage/` route proxies MinIO with Host passthrough so signatures stay valid |
| `HORIZON_AI_PROCESSES` | `4` | ai supervisor size (NFR-OPS-011) |
| `REVERB_APP_KEY` / `REVERB_APP_SECRET` | example values | also baked into the web build (key) — change for real deploys |

### Day-2

- TLS: terminate upstream (TASK-INF-004 Cloudflare) or add a `listen 443`
  block + cert mount in `infra/nginx/prod.conf`.
- Filament static (`public/css|js`) is copied into a shared volume by the
  one-shot `api-assets` service on every `up` — rebuilds of the api image
  propagate on the next `docker compose up -d`.
- Scale Reverb: add a second node + `REVERB_SCALING_ENABLED=true` (see the
  scaling section below; `nginx/reverb-upstream.conf` is a ready-made
  sticky upstream).
- Upgrades: `git pull && docker compose -f infra/docker-compose.prod.yml
  up -d --build` (migrations: the installer already ran them; later ones go
  `docker compose ... exec api php artisan migrate --force`).
- Backups: pg_dump cron per TASK-INF-007.

## Staging stack (DEC-045)

`docker-compose.staging.yml` is a thin **overlay** on the prod file — never
used alone — so staging mirrors prod exactly (same images, topology,
first-run installer) while co-existing with dev and prod on one host:

| | prod | staging |
|---|---|---|
| compose project / volumes | `banana-chat-prod` | `banana-chat-staging` (own state, networks) |
| edge port | `${HTTP_PORT:-80}` | `${HTTP_PORT:-8081}` (8080 is docker-desktop's on Macs) |
| MinIO console (localhost-only) | 9101 | 9201 |
| api env file | `apps/api/.env` | `apps/api/.env.staging` — dev's `.env` (Neon/remote Redis) never leaks in |

`APP_NAME` is tagged "(Staging)" so admin panels and mails are tellable
apart. Everything else — creds, Reverb keys, topology — is inherited from
the prod file.

```sh
touch apps/api/.env.staging      # must exist before `up` (bind mount)
make up-staging                  # = compose -f prod.yml -f staging.yml [+ --env-file infra/.env]
# open http://<host>:8081/setup → wizard, then restart the long-runners:
docker compose -f infra/docker-compose.prod.yml -f infra/docker-compose.staging.yml \
  restart worker scheduler reverb
make down-staging
```

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
