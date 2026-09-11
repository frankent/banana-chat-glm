# TASK-BE/WEB/CORE/QA-043 — public meetings

FR-MEET-001..005 / API-160..164 / API-156 / DEC-054.

Workspace members can create named meeting links from Meetings, copy them and end them. A link expires after the chosen 1 hour, 24 hours or 7 days (default). Up to 8 people may join. The public lobby derives signed-in account identity on the server; anonymous visitors enter a name and appear with a Guest suffix. Signing in from the lobby returns to that meeting.

Public meetings use separate tables and SFU rooms. A link gives access to that meeting's media only, never workspace membership, chat messages or attachments. Invalid supplied account credentials fail instead of silently becoming a guest. Guest participant secrets are hashed in the database and rotated on join; member participation is also tied to the login session. Ending the meeting persists revocation before external SFU deletion. The ten-second scheduler enforces link expiry, creator/workspace removal, participant revocation and reconnect grace.

The call renderer is shared with private room calls. Public meetings run outside the authenticated chat shell, so anonymous users need no workspace and leaving that route releases devices. Media controls include microphone/camera, device selection, screen sharing and creator-only end. This is a public-link meeting feature, not a public signup system, recording feature or waiting room.

## Review

Intent: let invited outsiders meet workspace members without giving them chat access. Extending private room membership with nullable guest users would couple chat authorization to public links; separate meeting capabilities keep those access paths distinct. `MediaPanel` reuses the existing media lifecycle and controls instead of implementing a second video stack.

Traced `MeetingController` optional auth → `MeetingService` serialized admission → signed media grant → existing nginx authorization subrequest → `participantAllowed` → `ReconcileMeetings`. Tests cover invalid bearer credentials, cross-workspace identity without chat access, guest name requirements, participant secret isolation, room-grant mismatch, creator-only revocation, expiry, archived workspaces, revoked sessions, capacity and media-outage persistence. A browser token owner marker prevents an old guest resume token from being presented as a newly signed-in member. The public SPA route disables referrers and caching.

Verdict: shipped after the production public-meeting and private-call checks passed. Remaining device/capacity limits are recorded below.

## Validation

- Full API: 380 passed, 2 skipped, 1752 assertions.
- Call + meeting API: 26 passed, 131 assertions (12 new meeting tests).
- Shared/client/core/mobile: 134 passed.
- Typecheck and web build passed. Targeted UI oxlint passed without warnings. Existing main/lazy media chunk-size advisories remain.
- OpenAPI parsed: 48 paths. This repository has no `gen:client` script; typed API wrappers were updated and typechecked.
- Local browser: 9 checks passed, using an isolated database, local API/nginx gate and the production SFU over the actual network. All three clients used forced TURN TLS with synthetic audio/video. Guest/member identity, member sign-in return, decoded video for all participants, mobile layout, screen sharing, member logout, guest rejoin and creator revocation passed.
- Native camera, microphone and speaker hardware is not certified by synthetic capture. The 8-person limit is not a concurrent-call capacity certification (OQ-018).

## Reproduce

`verify.mjs` defaults to local Vite 5173, isolated API `banana-chat-call-review` on 18000, nginx admission gate 18880 and a configured SFU. It creates only fresh prefixed QA users/workspace and removes them in `finally`. The media server's internal API must remain private; use a loopback-only SSH tunnel when testing locally against it.

`MEETING_QA_PRODUCTION=1 node docs/reviews/2026-09-11/meetings/verify.mjs` runs the same test against production with the authorized SSH connection at `/tmp/banana-meeting-ssh`. In production it waits for the real scheduler to revoke the logged-out member. Never run production fixtures without authorization. No access tokens, guest control tokens or passwords are written into reports.

## Production deployment — 2026-09-11

Deployed to https://chat.gamecoms.net. Runtime feature commit `ff8c0e9` was applied as a delta to the existing server checkout, preserving earlier incremental changes; its divergent non-runtime OpenAPI document was excluded. API/web images were rebuilt, the additive meeting migration applied, and API/worker/scheduler/Reverb/nginx recreated. The SFU and TURN services were not restarted.

Production public meetings passed 9 browser checks (`production-results.json`), including automatic scheduler eviction after member logout. Private calls passed 14 regression checks (`private-calls-results.json`), including voice/video, navigation, device cleanup, permissions, revocation and forced TLS relay. The public lobby responded with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and media permission headers. Nginx configuration validation passed.

Backups: `/root/banana-chat-backups/meetings-20260911`, including database dump and prior working-tree diff. Rollback image tags: `before-meetings-20260911`. Reverting those app/edge images disables the public-meeting UI/API without dropping additive tables; end any active public meetings before rollback because the previous scheduler does not reconcile them. Existing private calls use the prior implementation after rollback.

Both production fixture suites removed their own QA workspaces/users and SFU rooms. Local QA containers/database, the temporary loopback-only remote media proxy, SSH forward and local temporary media credential file were removed. Existing customer workspace/chat records were not changed.
