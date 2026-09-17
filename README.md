# Banana Chat (orgchat)

Self-hosted workspace chat — Laravel 12 API + Reverb WebSockets, React 19 web client, Expo mobile app, Filament 3 admin, LiveKit calls. `PRODUCT_SPEC.md` is the source of truth; §15/§16 carry every decision and change.

## Stack

| Layer | Tech |
|---|---|
| API | Laravel 12, PHP 8.4, PostgreSQL 16, Redis 7 (cache + queue + Horizon), MinIO (S3), Reverb (WS), ClamAV |
| Web | React 19, Vite, TanStack Query, Zustand, Tailwind 4, laravel-echo/pusher-js, livekit-client |
| Mobile | Expo SDK 57 (expo-router, RN 0.87), SQLite offline cache + outbox |
| Admin | Filament 3 at `/admin` (system admins only) |
| Media | LiveKit SFU (`calls` compose profile) — WebRTC + TURN |
| Packages | `packages/shared` (wire types), `packages/api-client` (typed fetch + token refresh), `packages/chat-core` (message store, gap-fill, unread math) |

## What's in the box

Auth (rotating refresh + reuse detection) · workspaces + isolation · DM/group/secret rooms · per-room `seq` ordering with idempotent sends · realtime, read receipts, unread badges · message edit/delete · mentions · typing indicators · full-text search over messages and files · attachments (presigned upload → `ProcessAttachment` → virus scan) · room notes · Kanban boards · **AI assistant** (streaming, memories, per-workspace quotas) · **voice/video calls + public meeting links** · **public support chat** (capability links + partner HMAC API) · push tokens · offline cache/outbox on mobile · Filament admin (users, workspaces, audit log, runtime settings).

---

## Local development

```bash
make install          # pnpm workspace + composer deps (composer runs inside apps/api)
make up               # postgres :5433, redis :6380, minio :9100, mailpit :8025, reverb :8088
make migrate && make seed
make dev-api          # terminal 1 — http://127.0.0.1:8000
make dev-worker       # terminal 2 — realtime broadcasts are queued
make dev-web          # terminal 3 — http://localhost:5173
```

The dev topology is hybrid: PHP/Vite on the host, stateful services + Reverb in Docker. An all-container `full` profile exists (`make up-full`).

**Ports:** postgres **5433** · redis **6380** · minio **9100/9101** · mailpit **8025** · reverb **8088** · api **8000** · web **5173**

### Demo accounts (after `make seed`)

| Login | Password | Where |
|---|---|---|
| `tony` | `Tony12345!` | acme owner |
| `anna` | `Anna12345!` | acme admin |
| `somchai` | `Somchai12345!` | acme member |
| `duangjai` | `Duangjai12345!` | acme member |
| `admin` | `Admin12345!` | system admin → `/admin` |

Workspaces `acme` (everyone) and `globex` (admin + tony) — tony is in both to demo switching/isolation.

### Testing

```bash
make test            # Pest (Postgres orgchat_test, never SQLite)
make test-web        # Vitest across packages
make typecheck       # tsc across packages
make ci-local        # all of the above + web build
make e2e             # headless two-browser smoke (Chrome; needs dev stack running)
```

---

# Production deployment

Single-host Docker deployment. Written from a real deploy; every gotcha below cost time on the way.

## 0. What you need

A Linux host with Docker ≥ 24 and Compose v2 (`docker compose version` — the prod compose uses `depends_on: condition: service_completed_successfully`), ~4 GB RAM for the build, and a few GB of disk. `make` is **not** required — every command below calls `docker compose` directly, because the Makefile isn't always present on a server and its `make migrate`/`make seed` targets run **host** PHP against the **host** `.env`, not the container.

Clone fresh on the server. **Do not rsync a working tree** — there is no `.dockerignore`, the nginx build context is the repo root, and a local `node_modules/` or `apps/api/vendor/` will be sucked into the build context.

```bash
sudo mkdir -p /opt/banana-chat && sudo chown "$USER": /opt/banana-chat
git clone https://github.com/frankent/banana-chat-glm.git /opt/banana-chat
cd /opt/banana-chat
```

## 1. Two env files, opposite rules — read this before editing either

This is the single most confusing part of the deployment, and getting it wrong fails **silently**.

| File | How it is used | Put a variable here when… |
|---|---|---|
| `infra/.env` | `--env-file` for compose. Only feeds `${VAR}` substitution **inside** `docker-compose.prod.yml`. | the variable appears in the compose file — i.e. it is in the `x-api-env` block or a `build.args` entry |
| `apps/api/.env` | bind-mounted to `/app/.env`; Laravel reads it directly. Owned by the `/setup` wizard. | nothing in compose references it |

These are the **only** variables `docker-compose.prod.yml` references, i.e. the complete set that belongs in `infra/.env`:

```
AWS_ENDPOINT  CALLS_ENABLED  HORIZON_AI_PROCESSES  HTTP_PORT
LIVEKIT_API_KEY  LIVEKIT_API_SECRET  LIVEKIT_URL
MINIO_CONSOLE_PORT  MINIO_ROOT_USER  MINIO_ROOT_PASSWORD
POSTGRES_DB  POSTGRES_USER  POSTGRES_PASSWORD
REVERB_APP_KEY  REVERB_APP_SECRET
VITE_API_BASE  VITE_REVERB_HOST  VITE_REVERB_PORT  VITE_REVERB_SCHEME
```

Anything not on that list — `AI_ALLOW_PRIVATE_HOSTS`, `CLAMAV_ENABLED`, `MAIL_*`, … — belongs in `apps/api/.env`. Regenerate the list after any compose change with:

```bash
grep -oE '\$\{[A-Z_]+' infra/docker-compose.prod.yml | sed 's/\${//' | sort -u
```

Two consequences that will bite you:

- **`CALLS_ENABLED`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL` must be in `infra/.env`.** The compose `environment:` block sets them explicitly, and compose env **beats** the bind-mounted `.env` inside the container (`variables_order = "EGPCS"` + `clear_env = no`). Put them in `apps/api/.env` and they are silently overridden by the defaults.
- **`AI_ALLOW_PRIVATE_HOSTS` must be in `apps/api/.env`.** It is not referenced anywhere in compose, so a value in `infra/.env` reaches nothing — `config('ai.allow_private_hosts')` stays `false` while the file looks correct.

## 2. Prepare files that must exist before the first `up`

```bash
cp infra/.env.example infra/.env
mkdir -p infra/livekit/acme-webroot          # nginx bind-mounts this
touch apps/api/.env && sudo chown 82:82 apps/api/.env
```

**Both paths must exist as files/directories first.** Docker creates a **root-owned directory** at any missing bind-mount path, and the stack then cannot be fixed without `down -v`.

`apps/api/.env` must be owned by uid **82** (`www-data` in Alpine) — php-fpm runs as that user and the installer writes this file. If it is root-owned the wizard **500s with nothing in the log**.

Leave `apps/api/.env` empty. Do not copy `.env.example` into it: those are dev values (`DB_PORT=5433`, `REDIS_PORT=6380`) and a non-empty `APP_KEY` would skip the wizard.

## 3. Edit `infra/.env`

Every line in `.env.example` is commented out, i.e. all defaults. Set at minimum:

```ini
# Baked into the SPA at BUILD time — a wrong value needs a full nginx rebuild, not a restart
VITE_REVERB_HOST=chat.example.com
VITE_REVERB_PORT=443
VITE_REVERB_SCHEME=https

HTTP_PORT=80                      # change if 80 is taken; then set VITE_REVERB_PORT to match

POSTGRES_PASSWORD=<openssl rand -hex 20>
MINIO_ROOT_PASSWORD=<openssl rand -hex 20>     # doubles as AWS_SECRET_ACCESS_KEY
REVERB_APP_KEY=<openssl rand -hex 20>          # also an nginx build arg
REVERB_APP_SECRET=<openssl rand -hex 20>

# MUST be the edge HOST ROOT, no /storage path
AWS_ENDPOINT=https://chat.example.com
```

**`AWS_ENDPOINT` is host root on purpose.** SigV4 signs the endpoint *path*, and nginx forwards `location /orgchat/` to MinIO **verbatim** so what was signed is what MinIO receives. An endpoint of `https://host/storage` makes the SDK sign `/storage/orgchat/key` while MinIO receives `/orgchat/key` — every attachment 403s. (`/storage/` still exists for unsigned public reads; it is not for presigned URLs.)

**`VITE_REVERB_*` and `REVERB_APP_KEY` are nginx build args.** Changing them later means `up -d --build nginx`, not a restart.

## 4. MinIO images are no longer on Docker Hub

`docker-compose.prod.yml` still references `minio/minio` and `minio/mc`. Both now fail:

```
pull access denied for minio/minio, repository does not exist or may require 'docker login'
```

MinIO publishes on **quay.io**. Add an overlay (and include it in every later compose call):

```bash
cat > infra/docker-compose.minio-quay.yml <<'YML'
services:
  minio:
    image: quay.io/minio/minio:latest
  minio-init:
    image: quay.io/minio/mc:latest
YML
```

A small wrapper keeps the `-f` list consistent — every command after this uses `./dc`:

```bash
cat > dc <<'SH'
#!/bin/bash
cd "$(dirname "$0")"
exec docker compose --env-file infra/.env \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.minio-quay.yml "$@"
SH
chmod +x dc
```

If your user isn't in the `docker` group: `sudo usermod -aG docker "$USER"` and open a new shell. Detached builds cannot answer a `sudo` password prompt.

## 5. Build and start

```bash
./dc up -d --build
```

First build compiles PHP extensions from source and runs a Vite production build — several minutes, and ClamAV downloads a ~200 MB signature database on first boot. Run it detached from your SSH session:

```bash
setsid nohup ./dc up -d --build < /dev/null > /tmp/bc-build.log 2>&1 &
```

`worker`, `scheduler` and `reverb` crash-loop harmlessly until the wizard writes `.env` in the next step. `api-assets` and `minio-init` are one-shot containers — `Exited (0)` is their correct final state, not a fault.

The prod stack publishes only **`${HTTP_PORT}` (80)** and **`127.0.0.1:9101`** (MinIO console). LiveKit's ports are behind the `calls` profile and do not start by default.

## 6. First-run wizard

Open **`http://<public-host>/setup`** in a browser.

Open it on the hostname users will actually use — `APP_URL` is derived from `$request->getSchemeAndHttpHost()`, so visiting through an SSH tunnel to `localhost` bakes the wrong value.

The form prefills `127.0.0.1`, which is **wrong inside a container**. Enter:

| Field | Value |
|---|---|
| DB host / port | **`postgres`** / **`5432`** |
| DB name / user | `orgchat` / `orgchat` |
| DB password | your `POSTGRES_PASSWORD` |
| Redis host / port | **`redis`** / **`6379`** (no password) |
| Mail host | a real SMTP host — **the field is required** and prod has no mailpit |

The wizard probes Postgres and Redis over raw PDO/RESP first, writes `apps/api/.env`, runs `migrate --force`, creates the first admin/workspace/room, then locks itself out with `storage/app/setup-complete`. **You do not run `make migrate` or `key:generate`.**

Ignore the `REVERB_APP_KEY` the wizard writes into `apps/api/.env` — it is a random value that never takes effect, because compose's `environment:` wins. The effective key is the one from `infra/.env`, which is fed to both the API and the web build, so they always match.

## 7. Post-install fixes (required)

```bash
./dc exec api sh -c 'chown -R 82:82 /app/storage'
./dc restart worker scheduler reverb
```

The long-runners booted before `.env` existed and cache env at start. The storage `chown` matters because `worker`/`scheduler`/`reverb` run artisan as root and create `storage/logs/laravel.log` first, after which www-data cannot append to it.

Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<host>/api/v1/health   # 200
./dc ps                                                                # all healthy
```

## 8. TLS

The prod nginx listens on **port 80 only** (`listen 80 default_server`) and has **no** `ssl_certificate` directive — TLS is designed to terminate upstream. It reads `X-Forwarded-Proto` into a `fastcgi_param HTTPS`, which is what makes Laravel generate `https://` URLs and secure cookies without any `trustProxies` config.

### Behind Cloudflare (proxied)

Works, including WebSockets. Enable **WebSockets** in the CF dashboard and bypass cache for `/api*` and `/rtc*`.

If the origin is not reachable on port 80 — e.g. a residential line where 80/443 can't be forwarded — Cloudflare returns **521**. Fix it with **Rules → Origin Rules**: *Hostname equals `chat.example.com` → Rewrite to → Destination Port = `<your forwarded port>`*. Origin Rules accept any port; the client-side port stays 443.

Caveats worth knowing before you pick **Flexible** mode:
- The Cloudflare→origin hop is **cleartext**. Users see a valid padlock regardless. **Full** mode + an Origin Certificate on nginx removes that leg.
- Cloudflare's free plan caps request bodies at **100 MB**; the app allows 250 MB attachments. Files in between are rejected by Cloudflare and never reach you.
- nginx has no `real_ip_header`/`set_real_ip_from`, so **every rate limit keys on the Cloudflare edge IP**. Public-meeting guests share one `throttle:20,1` bucket per CF POP.
- Your origin stays directly reachable on its own hostname/port, bypassing Cloudflare entirely.

---

# Calls and public meetings (optional)

LiveKit runs behind the `calls` compose profile and does **not** start with `up -d`.

Signaling needs **no extra port** — LiveKit's port 7880 stays internal and nginx proxies it at `/rtc` behind an `auth_request` gate. Only media/TURN needs forwarding:

| Port | Proto | Purpose |
|---|---|---|
| `turn.tls_port` (443, or 5349) | TCP | TURN over TLS — the fallback that traverses restrictive firewalls |
| 7881 | TCP | ICE/TCP |
| 7882 | UDP | primary WebRTC media |
| 3478 | UDP | STUN/TURN |
| 50000–50099 | UDP | TURN relay allocations |

## Setup

```bash
cp infra/livekit/config.example.yaml infra/livekit/config.yaml
chmod 600 infra/livekit/config.yaml
```

Edit it: a random `keys:` pair, `turn.domain` = your **DNS-only** TURN hostname, and `turn.tls_port`. Then in `infra/.env`:

```ini
CALLS_ENABLED=false            # flip to true only after the relay check below
LIVEKIT_API_KEY=<key name, must match keys: in config.yaml>
LIVEKIT_API_SECRET=<32+ random bytes, must match>
LIVEKIT_URL=wss://chat.example.com
```

**`LIVEKIT_URL` is the origin only — no path.** The `livekit-client` SDK appends `/rtc/v1` itself. Writing `wss://host/rtc` produces `/rtc/rtc/v1` and 404s. (The README in `infra/livekit/` says the URL "must use the gated `/rtc` path" — that describes the *effective* path, supplied by the SDK.)

`LIVEKIT_INTERNAL_URL` is hard-coded to `http://livekit:7880` in compose and is not operator-settable.

Start it:

```bash
./dc --profile calls up -d
```

## Gotchas that cost real time

- **Raise UDP buffers.** LiveKit warns `UDP receive buffer is too small for a production set-up` at the 212 KB default and media degrades under load:
  ```bash
  printf 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000\n' | sudo tee /etc/sysctl.d/99-livekit.conf
  sudo sysctl -p /etc/sysctl.d/99-livekit.conf
  ```
- **A non-443 TURN port must be changed in two places** — `turn.tls_port` in `config.yaml` **and** the published port in compose (which ships `"443:443/tcp"`). Change one only and TURNS binds inside the container with nothing published, while everything else looks healthy.
- **Dynamic/residential WAN:** `config.example.yaml` hardcodes `node_ip` with `use_external_ip: false`. On a changing IP that breaks every new ICE candidate until you edit and restart. Use `use_external_ip: true` instead.
- **`renew-certificate.sh` is not generic.** It pins `root=/opt/banana-chat` and the `media.gamecoms.net` lineage, and `exit 0`s on anything else — certbot reports success while LiveKit serves a stale cert until it expires. Copy it and edit both values for your host.
- **Never put the TURN hostname behind a proxy.** It must be DNS-only with an independently trusted certificate; browsers validate it directly.
- **Cert renewal restarts LiveKit, which drops active calls.** Schedule the certbot timer accordingly.
- Verify with a forced-relay connection (`iceTransportPolicy: relay`, `turns:` URLs only) **before** setting `CALLS_ENABLED=true`; check the selected candidate reports `relayProtocol: tls`. See `infra/livekit/README.md` and `docs/reviews/2026-09-11/calls/verify-turn.mjs`.

The SFU is capped at 1 CPU / 768 MB, and `call.max_participants` defaults to **8** (admin-editable, 2–50). That value is **snapshotted when a meeting is created**, so changes only affect new links.

---

# Operations

## Feature flags

| Flag | Where | Default |
|---|---|---|
| `CALLS_ENABLED` | `infra/.env` | `false` — gates calls **and** public meetings |
| `publicchat.enabled` | admin → Settings | `false` — ships off deliberately (DEC-071); a kill switch, OFF stops writes only |
| `ai.enabled`, `ai.memory.enabled` | admin → Settings | `true` |
| `AI_ALLOW_PRIVATE_HOSTS` | `apps/api/.env` | `false` — lets an AI provider `base_url` point at a private/LAN address |
| `CLAMAV_ENABLED` | `apps/api/.env` | `true` |

`AI_ALLOW_PRIVATE_HOSTS=true` disables the SSRF private-range check for AI providers. Any system admin can then make the server request **any** address on your network, including cloud metadata endpoints. Only enable it when a provider genuinely lives on your LAN.

## Upgrades

```bash
git pull
./dc up -d --build
./dc exec api php artisan migrate --force
```

Changing `VITE_*` or `REVERB_APP_KEY` requires `--build` (they are nginx build args), not just a restart.

## Common failures

| Symptom | Cause |
|---|---|
| Wizard 500s with an empty log | `apps/api/.env` is root-owned — `chown 82:82` |
| Stack unrecoverable after first `up` | a bind-mount path didn't exist, so Docker made a root-owned directory — `down -v` and redo step 2 |
| Every attachment 403s | `AWS_ENDPOINT` has a `/storage` path — must be host root |
| WebSockets fail only for remote users | `VITE_REVERB_HOST` still `localhost`; rebuild nginx |
| `pull access denied for minio/minio` | Docker Hub images are gone — add the quay.io overlay (step 4) |
| `/rtc` handshake returns 500 | the API answered non-2xx/401/403 — usually `CALLS_ENABLED=false` or an empty `LIVEKIT_*` **in the container** |
| Calls connect then drop on reconnect | media tokens carry a hard-coded **60-second** `exp`; a reconnect later than that is refused and the client ends the call |
| A setting change has no effect on workers | `worker`/`scheduler`/`reverb` cache env at boot — restart them |

Debugging note: `/rtc` sets `error_log /dev/null` and `access_log off` on purpose (bearer tokens ride in the query string), so the edge logs nothing. Your visibility is `./dc logs api`.

---

## Repo layout

```
apps/api        Laravel API + Filament admin + openapi.yaml
apps/web        React chat client
apps/mobile     Expo app (SQLite cache + outbox)
packages/       shared · api-client · chat-core (pure TS, unit-tested)
infra/          docker-compose (dev, prod, staging), nginx, livekit
docs/           reviews, QA harnesses, verification scripts
PRODUCT_SPEC.md the spec (§0 rules, §15 decisions, §16 changelog)
```

CI (`.github/workflows/ci.yml`) runs Pest, Vitest, tsc and the web build on push.
