# Banana Chat edge (TASK-INF-002/003): builds the web SPA, then serves it
# with nginx which also proxies /api→php-fpm, /app/*→Reverb (ws) and
# /storage/→MinIO (infra/nginx/prod.conf).
# Build context MUST be the repo root: dockerfile: infra/nginx/Dockerfile
FROM node:22-alpine AS web
WORKDIR /repo
RUN corepack enable

# Lockfile resolution needs every workspace importer's manifest first
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/chat-core/package.json packages/chat-core/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @banana-chat/web...

COPY . .
# Vite bakes these at build time — pass the deploy's real public host via
# build args (compose reads them from the environment / infra/.env; DEC-044):
#   docker compose -f infra/docker-compose.prod.yml build nginx
#     VITE_REVERB_HOST=chat.example.com VITE_REVERB_SCHEME=https
ARG VITE_API_BASE=/api/v1
ARG VITE_REVERB_HOST=localhost
ARG VITE_REVERB_PORT=80
ARG VITE_REVERB_SCHEME=http
ARG VITE_REVERB_APP_KEY=banana-chat-key
# `pnpm run` re-verifies deps and would auto-install the FULL workspace
# (pulling mobile's native better-sqlite3 — no gyp toolchain here).
# node --run executes the script directly, node_modules/.bin on PATH.
RUN cd apps/web && node --run build

FROM nginx:1.27-alpine
COPY --from=web /repo/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/prod.conf /etc/nginx/conf.d/default.conf
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
