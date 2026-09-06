# Banana Chat (orgchat)

Read `PRODUCT_SPEC.md` before touching anything — it is the source of truth.
Workflow for AI agents: `PRODUCT_SPEC.md` §0 + Appendix B.

Key rules:
- Every requirement has an ID (`FR-*`, `API-*`, `EVT-*`, `TC-*`, `TASK-*`, `DEC-*`, `OQ-*`).
  IDs must appear in commit messages, test names, and PR descriptions.
- Never change specced behavior without adding a `DEC-xxx` in §15 and a Changelog row in §16.
- Terminology: **workspace** (not team/org), **room** (not channel), **member**, **attachment**.
- Platform-agnostic client logic lives in `packages/chat-core` (unit-tested with Vitest), never in apps.

## Repo layout (spec §3.4)

```
apps/api      Laravel 12 (REST API + Reverb + Filament admin + workers)
apps/web      React 19 + Vite + TS
packages/     shared (types/zod/i18n) · api-client · chat-core
infra/        docker-compose, nginx
```

## Dev quickstart

See `README.md`. Short version: `make up && make migrate && make seed`, then
`make dev-api` / `make dev-reverb` / `make dev-web` in three terminals.

Composer note: use `/opt/homebrew/bin/composer` (2.8) — the default `composer`
on PATH is an old 1.10 source install that cannot run Laravel 12 tooling.
