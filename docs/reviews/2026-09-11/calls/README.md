# TASK-BE/WEB/CORE/INF/QA-042 — room calls

FR-CALL-001..005 / API-150..156 / EVT-070 / DEC-052 / OQ-018.

Implemented video calls in direct and group rooms and voice calls in direct rooms. Includes an incoming invitation, join/decline, microphone/camera/device controls, screen sharing, participant grid, mobile layout, minimize while chatting, leave and starter-only end-for-everyone. Initial group limit is 8 participants. Platform-independent attempt cancellation and ringing eligibility live in chat-core.

**Deployed and enabled on https://chat.gamecoms.net on 2026-09-11.** `media.gamecoms.net` resolves directly to the host. Its Let's Encrypt certificate, automated renewal and forced TURN TLS transport passed verification. Certificate expiry at deployment: 2026-12-10; renewal dry-run passed. Physical-device acceptance remains open in OQ-018: this environment's native Chromium capture remained pending, so the media harness uses explicit synthetic audio/video.

## Verification

- `production-results.json`: 14 checks passed against the deployed production API, nginx gate and LiveKit, with all calls forced through TURN TLS 443. Three temporary QA users and one isolated workspace were deleted after each run. Every visible participant video was checked for decoded frames. `turn-relay.json` separately records bidirectional RTP and TLS relay provenance. Production desktop/mobile screenshots contain only generated QA content.
- `results.json`: 13 pre-deployment browser checks passed. Real Laravel API and production nginx signaling-gate configuration ran against an isolated local database. The official LiveKit v1.13.6 SFU ran temporarily on the production host, with its signaling API accessible only through an SSH tunnel. Media traversed the actual network to the host, using synthetic audio/video capture. No customer accounts or workspace records were used or modified.
- Verified received audio/video RTP bytes, 3 participants, microphone toggle, synthetic screen sharing, mobile layout, navigation, DM/group leave semantics, actual SFU eviction after room-membership removal, permission-error recovery, track cleanup, logout revocation and rejection of ended-call credentials at nginx.
- API call suite: 14 tests, 56 assertions. Covers room/workspace isolation, media grants, capacity, decline/end permissions, session revocation, media-outage revocation persistence, reconciliation and notification sound preference.
- Existing API regression and shared/client/mobile tests, typecheck and web build were run; final totals are recorded in `validation.json`.
- No physical camera/speaker assertion, 8-person load certification, native mobile calling UI, recording or closed-browser push ringing is claimed.

## Security and lifecycle

API membership checks bind every call to a workspace and room. Media identities are opaque participant records tied to a login session. JWT grants only authorize the specific call; voice grants only permit microphone publishing. The SFU has room auto-creation disabled. Nginx validates current app membership/session state on every signaling admission and suppresses credential-bearing RTC request logs. The ten-second scheduler reconciles revocations, disconnected participants, unanswered DMs and orphaned media rooms. Ending a call persists revocation before attempting SFU deletion, so an outage cannot restore access; subsequent reconciliation retries cleanup.

## Integration findings resolved

1. The local Docker dependency volume needed the newly added JWT package; updating only the host Composer install did not update that volume.
2. Local Docker ICE routing failed. A temporary remote SFU established the actual cross-network transport. Separately, native capture remained pending in an independent browser reproduction; the harness therefore uses explicit synthetic capture, not a claim of physical-device success.
3. LiveKit Twirp requires `{}` for empty request bodies and `roomCreate` for DeleteRoom. Both have regression assertions.
4. The local FPM test image inherited unrelated database defaults. Explicit local database credentials/SSL settings corrected the test environment; production database settings were not changed.
5. Removing a group starter now evicts that member while preserving the other participants, matching normal group leave semantics; a regression covers the distinction from DM termination.
6. Logout could precede the first connected-state reconciliation. The regression first failed, then passed after reconciliation also checked app participants already absent from the SFU and ended a DM when a participant was revoked.

## Running the browser check

`verify.mjs` requires a dedicated `orgchat_call_review` database, a `banana-chat-call-review` API container configured to that database, Vite on 5173 and the production nginx gate on 18880. Configure the API and gate to the same test SFU. The script creates fresh synthetic users/rooms in the dedicated database. The media capture overrides exist only in the harness. Never point this fixture script at the customer database.

Deployment instructions and configuration template: `infra/livekit/README.md` and `infra/livekit/config.example.yaml`.

The pre-deployment temporary SFU, local QA containers and database were removed. The production SFU now runs in the `calls` profile. The temporary loopback-only relay test proxy and SSH forward were removed after testing; the API port remains private. Production QA workspaces/users were deleted and no existing customer room/message content was changed. The site returns HTTP 200.

## Production deployment

Runtime feature delta from `8410954` was applied to the server's existing incremental checkout without resetting its changes. The divergent server OpenAPI document was excluded from the runtime patch. All app/edge images were built, the additive call migration applied, and API/worker/scheduler/Reverb/nginx recreated. Activation occurred only after forced-relay media passed. Backup and rollback images are under `/root/banana-chat-backups/calls-20260911` and `before-calls-20260911`; the database backup is retained. Disable `CALLS_ENABLED` and recreate API/worker/scheduler/Reverb, then stop LiveKit to roll back calling without removing additive tables.

`verify-production.mjs` uses a multiplexed SSH connection at `/tmp/banana-calls-ssh`, creates only its fresh prefixed fixture in production, and deletes it in `finally`. It needs explicit production authorization. `verify-turn.mjs` additionally needs local Vite and a temporary loopback-only SFU proxy forwarded to 17880; run it before activation (the active scheduler intentionally deletes orphan SFU rooms). No production secrets are stored in these scripts.

The forced-relay failure and repair are documented in `relay-postmortem.md`. SDK warnings about absent initial device preferences and closed connections during deliberate teardown were observed; no uncaught page errors occurred.
