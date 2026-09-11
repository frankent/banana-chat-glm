# Project workflow

Read `CLAUDE.md` and the relevant requirements in `PRODUCT_SPEC.md`.

The user designated `https://chat.gamecoms.net` as the team's production
deployment on 2026-09-11 and authorized deploying completed changes there.
Production SSH target: `root@165.22.63.119`; application: `/opt/banana-chat`.
Use `infra/docker-compose.prod.yml` with `--env-file infra/.env`.

Verify each change before deployment, retain a rollback image, deploy the
affected services, and verify the public deployment afterward. Use Playwright
for chat UI changes. Test with isolated QA users/workspaces and clean up only
those fixtures. Never store credentials in repository files.
