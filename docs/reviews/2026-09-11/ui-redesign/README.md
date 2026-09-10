# Web UI refresh — TASK-WEB-002 / TASK-WEB-006 / TASK-WEB-018

Adapted the visual design from the sibling `banana-chat` web app: forest-green navigation rail, cream sidebar, yellow highlights, avatars, rounded message bubbles, composer, login and welcome screens. Existing room ordering and controls remain available. Mobile navigation, notifications and media panels fit narrow screens.

Only web presentation and drawer state changed. Existing API contracts, authentication, subscriptions, read receipts, outbox/retry, uploads, search and AI handlers were retained. No new feature or behavior decision is introduced.

## Validation

- Web TypeScript check and production build pass (existing large-chunk warning remains).
- Workspace unit tests: 123 passed, including chat-core and mobile regression tests.
- `verify.mjs`: real browser/API/Reverb regression suite; detailed outcomes in `results.json`. Includes fresh DM, background previews/unread, focused delivery, reconnect, persisted retry, scroll/search anchors, edit/delete, session isolation and mobile navigation/notification/media layout.
- Desktop login/chat/welcome and mobile screenshots inspected.
- Tests use a separate `orgchat_review_20260911` database, API port 18000 and temporary users/workspace. They do not run against production.

The UI refresh does not constitute a new end-to-end certification of every feature: external AI generation and every attachment format were not re-exercised in this presentation-only pass. 

## Local reproduction

Run the existing development services and Vite at port 5173. Create and migrate the isolated database above, then expose an API container at port 18000 using that database, `CACHE_PREFIX=review_20260911`, `QUEUE_CONNECTION=sync`, and `FILESYSTEM_DISK=local`. Run:

```sh
node docs/reviews/2026-09-11/ui-redesign/verify.mjs
```

The runner creates and deletes its own fixture users/workspace. Keep development and production databases separate from this fixture database.

## Production deployment — 2026-09-11

Deployed the web changes from commit `141aea6` to https://chat.gamecoms.net after explicit approval. Applied the UI patch on top of the existing production fixes, built nginx on the server with its production environment, and recreated only nginx. No migrations or database changes. Previous image retained as `banana-chat-prod-nginx:before-ui-141aea6`; backup patch and build log are in `/root/banana-chat-backups/ui-141aea6/`. All services healthy after deployment.

Live checks with the authorized test accounts passed: login and WebSocket connection; existing DM listing (fresh-room creation was not re-tested on production); background delivery/unread; workspace badge; open-room receipt; redesigned desktop/mobile navigation and no horizontal overflow; no browser runtime errors. Six checks passed; see `production-results.json`.
