# TASK-BE/WEB/CORE/INF/QA-042 — room calls

FR-CALL-001..005 / API-150..156 / EVT-070 / DEC-052 / OQ-018.

Implemented video calls in direct and group rooms and voice calls in direct rooms. Includes an incoming invitation, join/decline, microphone/camera/device controls, screen sharing, participant grid, mobile layout, minimize while chatting, leave and starter-only end-for-everyone. Initial group limit is 8 participants. Platform-independent attempt cancellation and ringing eligibility live in chat-core.

**Production activation is pending OQ-018.** `CALLS_ENABLED` defaults to false. No customer-facing deployment was performed for this feature. The proposed TURN hostname still resolves through Cloudflare; DNS-only routing and a trusted TURN certificate are needed before forced-relay verification and activation. Physical-device capture also needs a supported-device check; this environment's native Chromium `getUserMedia` remained pending even in a standalone reproduction with permission granted.

## Verification

- `results.json`: 13 browser checks passed. Real Laravel API and production nginx signaling-gate configuration ran against an isolated local database. The official LiveKit v1.13.6 SFU ran temporarily on the production host, with its signaling API accessible only through an SSH tunnel. Media traversed the actual network to the host, using synthetic audio/video capture. No customer accounts or workspace records were used or modified.
- Verified received audio/video RTP bytes, 3 participants, microphone toggle, synthetic screen sharing, mobile layout, navigation, DM/group leave semantics, actual SFU eviction after room-membership removal, permission-error recovery, track cleanup, logout revocation and rejection of ended-call credentials at nginx.
- API call suite: 14 tests, 56 assertions. Covers room/workspace isolation, media grants, capacity, decline/end permissions, session revocation, media-outage revocation persistence, reconciliation and notification sound preference.
- Existing API regression and shared/client/mobile tests, typecheck and web build were run; final totals are recorded in `validation.json`.
- No physical camera/speaker assertion, forced TURN/TLS relay result, 8-person load certification, native mobile calling UI, recording or closed-browser push ringing is claimed.

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

The temporary remote SFU, local QA containers and dedicated QA database were removed after verification. The customer-facing production site continued returning HTTP 200.
