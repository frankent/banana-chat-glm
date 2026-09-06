# Banana Chat (orgchat)

Self-hosted internal workspace chat — Laravel 12 API + Reverb WebSockets, React 19 web client, Filament 3 admin. This is the **PH1 MVP** build. `PRODUCT_SPEC.md` is the source of truth.

## Stack

| Layer | Tech |
|---|---|
| API | Laravel 12, PHP 8.4, PostgreSQL 16, Redis 7 (cache + queue), MinIO (S3), Reverb (WS) |
| Web | React 19, Vite, TanStack Query, Zustand, Tailwind 4, laravel-echo/pusher-js |
| Admin | Filament 3 at `/admin` (system admins only) |
| Packages | `packages/shared` (wire types), `packages/api-client` (typed fetch + token refresh), `packages/chat-core` (message store, gap-fill, unread math) |

## Quickstart

```bash
make install          # pnpm workspace + composer deps (composer runs inside apps/api)
make up               # postgres :5433, redis :6380, minio :9100, mailpit :8025, reverb :8088
make migrate && make seed
make dev-api          # terminal 1 — http://127.0.0.1:8000
make dev-worker       # terminal 2 — realtime broadcasts are queued
make dev-web          # terminal 3 — http://localhost:5173
```

The dev topology is hybrid (plan D1): PHP/Vite run on the host, stateful services + Reverb in Docker. An all-container `full` profile exists (`make up-full`).

### Cloud infra (Neon + DigitalOcean Spaces + remote Redis)

The data layer can run on managed services instead of local Docker. Credentials live in `apps/api/.env.cloud.local` (gitignored). Switch with:

```bash
make use-cloud     # Neon Postgres + DO Spaces (s3 disk, prefix banana-chat/) + remote Redis (cache+queue)
make which-env     # show what .env currently points at
make use-local     # restore the local Docker env backup
```

Notes:
- Migrations + seed already applied to Neon (`neondb`); demo accounts work there too.
- Tests always run against the local `orgchat_test` Docker DB — never the cloud one.
- After switching env, restart any `queue:work` process (it caches env at boot).
- Realtime still needs Reverb (local container or self-hosted); see EMQX note in the deviation log.

### Demo accounts (after `make seed`)

| Login | Password | Where |
|---|---|---|
| `tony` | `Tony12345!` | acme owner |
| `anna` | `Anna12345!` | acme admin |
| `somchai` | `Somchai12345!` | acme member |
| `duangjai` | `Duangjai12345!` | acme member |
| `admin` | `Admin12345!` | system admin → `/admin` panel |

Workspaces: `acme` (everyone above) and `globex` (admin + tony) — tony is in both to demo workspace switching/isolation.

### Admin panel

`http://localhost:8000/admin` — log in with `admin` / `Admin12345!`. Manage users (create with temp password, suspend → kills sessions, reset, deactivate), workspaces (assign members, archive), audit log, runtime settings.

## Ports

postgres **5433** · redis **6380** · minio **9100/9101** · mailpit **8025** · reverb **8088** · api **8000** · web **5173**
(Host 6379/8080 were taken — see spec deviation log.)

## Testing

```bash
make test            # Pest (Postgres orgchat_test, never SQLite)
make test-web        # Vitest across packages
make typecheck       # tsc across packages
make ci-local        # all of the above + web build
make e2e             # headless two-browser smoke (Chrome; needs dev stack running)
```

CI (`.github/workflows/ci.yml`) runs the same matrix on push.

## Repo layout

```
apps/api        Laravel API + Filament admin + openapi.yaml
apps/web        React chat client
packages/       shared · api-client · chat-core (pure TS, unit-tested)
infra/          docker-compose (dev + full profile)
PRODUCT_SPEC.md the spec (§0 rules, §15/§16 deviation log)
```

## PH1 scope notes

Shipped: auth (rotating refresh + reuse detection), workspaces + isolation, DM/group rooms, messages with per-room `seq` ordering + idempotent sends, realtime (Reverb) + read receipts + unread badges, admin panel, demo seed, tests, E2E smoke.

Deferred (schema present, UI/API not): media upload, AI, push, search, edit/delete, mentions, typing/presence, mobile — see the deviation log in `PRODUCT_SPEC.md` §15/§16.
