# Review fixes — 2026-09-11

Scope: numbered findings in REVIEW.md and DM/unread verification. Existing DM user-channel fix at 537fed4 is retained. This is not a claim of full Telegram feature parity.

## Implemented

- FR-AUTH-003/FR-OFF-001: user/workspace-scoped stores and queries; logout clears memory/drafts; old HTTP responses and token refreshes cannot enter a later session.
- FR-MSG-009/FR-RT-002: merge authoritative history without discarding live messages; reconnect catch-up includes missed edits/deletions and multiple pages. Native room watchers added for message create/update/delete and foreground reconnect.
- FR-OFF-002: web uses shared persistent Outbox; original client_message_id survives reload/retry; failed head blocks subsequent messages in the same room; interrupted sending restores to pending; dispose prevents later delivery callbacks.
- FR-MSG-003/FR-SRCH-001: preserve viewport while prepending; keep around_seq until explicit return to latest.
- FR-READ-001/003: viewport/focus-aware one-second receipts; reactive workspace summary query; actual unread totals and muted/deleted-room exclusions (DEC-047).
- FR-MEDIA-001/API-060/061: shared multipart ticket handling and ordered ETags in web/mobile upload adapters. Complete accepts parts. Existing server purge aborts expired multipart sessions.

- FR-MSG-002/004/008, EVT-010/011: production multipart probe found that `MessageSerializer::forEvent` passed an array followed by extra arguments to Laravel `loadMissing`. Laravel ignores the extra arguments when the first argument is an array, so broadcast payloads omitted attachments/mentions/reply while REST loaded them later. One relation array now includes all four relations. TC-MEDIA-012 failed before the fix and passes after it, comparing REST and broadcast payloads.

## Validation

- Shared/api-client/mobile unit suites: 123 tests passed.
- API host PHP with GD: 309 passed, 2 skipped, 1,280 assertions. Container PHP lacks GD: 19 media failures there; rerun with host GD passed. Tests use orgchat_test.
- Typecheck across web/mobile/shared and web production build passed; existing bundle-size warning remains.
- Real browser/API/Reverb regression: 12 cases passed in `dm-fix/results.json`. Includes fresh DM, background preview/unread/burst, workspace badge, read clearing, room reopen, disconnected delivery catch-up, persisted failed send/retry (four attempts, one UUID/one stored message), history scroll/search/read viewport, account switch without reload, and runtime errors.
- Production before change: existing tony/tony2 DM delivers background messages and room unread correctly; workspace badge fails. See `production/before.json`. Messages sent by verification are explicitly marked QA.
- Native device delivery is not yet verified by these unit/browser checks. Missing product features in the initial review remain separate work.
- OpenAPI multipart contracts updated manually alongside shared/client types. Repository has no `pnpm gen:client` script to run (Appendix B tooling gap).

## Test incident and recovery status

An initial `docker compose exec api php artisan test` run inherited DB_DATABASE=orgchat from Compose, overriding the non-forced phpunit.xml setting. RefreshDatabase reset the local dev database. The test process was stopped; inspection found zero users/workspaces. No matching local database backup was found in the project or the inspected temporary/parent locations; PostgreSQL archiving is off. Data has not been restored or replaced with seed data. The user was informed and asked for an external backup location.

phpunit.xml now forces the test database, cache/session/queue and storage settings. Subsequent API tests use orgchat_test; browser tests use orgchat_review_20260911 and a separate API container on localhost:18000. Production was not involved in the reset. Before any production edit a pg_dump custom archive and configuration copies were saved with mode 0600 on the production server under /root/banana-chat-backups/review-20260911; pg_restore --list validated the archive structure.

Do not interpret reseeding or a production database copy as recovery of the original dev data.

## Production rollout

Source baseline: 537fed4. Applied reviewed patches without migrations, and built/recreated web/API/worker/scheduler/Reverb images. Original images are retained as `banana-chat-prod-<service>:before-review-20260911`. Patches and build logs are beside the production backup. The initial production rollout applied patches before the subsequent Git commit/push requested by the user; the production checkout may still show those applied changes.

Initial post-deploy tony/tony2 checks passed background delivery, room unread, workspace badge and read clearing. A 60 MiB upload completed in eight parts and became ready, but receiver realtime payload contained zero attachments. A second probe reproduced that exact path with both sockets receiving the message and no failed jobs; this isolated serialization from transport and led to TC-MEDIA-012 above.

Final production verification after the serializer fix: **6/6 passed** (`production/results.json`). tony → tony2 background room preview/unread, workspace badge, read clearing and runtime-error checks passed. Real S3-compatible 60 MiB upload used eight parts, returned 201 for the message, and both sockets delivered the attachment filename; recipient rendered it without reload. The tony/tony2 DM already existed, so fresh-DM creation is covered by the isolated 12-case suite, not claimed as a fresh-room production test.

The updated native source is typechecked/unit-tested but has not been released or validated on two physical devices. Missing room-management UI, web push, typing/presence and other feature gaps recorded in REVIEW.md are not represented as completed by this fix.

Final service check: all nine production containers healthy; public health endpoint reports database/Redis/storage/Reverb/queue healthy with queue lag 0. Server SHA-256 of MessageSerializer and WorkspaceSummaryBuilder matched the local reviewed files.

### Rerun the isolated browser suite

From repository root, with the existing dev web/Reverb stack running:

```sh
docker compose -f infra/docker-compose.yml exec -T postgres createdb -U orgchat orgchat_review_20260911
docker compose -f infra/docker-compose.yml exec -T -e DB_DATABASE=orgchat_review_20260911 api php artisan migrate --force
docker compose -f infra/docker-compose.yml run -d --no-deps --name banana-chat-review-20260911 -p 18000:18000 -w /app/public -e DB_DATABASE=orgchat_review_20260911 -e CACHE_PREFIX=review_20260911 -e QUEUE_CONNECTION=sync -e FILESYSTEM_DISK=local api php -S 0.0.0.0:18000 /app/vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php
node docs/reviews/2026-09-11/dm-fix/verify.mjs
```

The suite proxies API requests to the separate port, creates isolated accounts/workspace, and removes its own fixtures in finally. The temporary review container/database created during this session were removed after verification. No cleanup or reseed was performed on the reset dev database.

Text reports, reproduction scripts and JSON results are versioned. Screenshots and raw test logs remain local review artifacts.
