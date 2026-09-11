# FR-NOTI-007 / FR-READ-003 / TC-WEB-043 — login and browser attention

DEC-050. User requested first-login room visibility, notification sound and tab unread, with production deployment.

## Reproduction and cause

Production fresh login as tony at desktop width returned two rooms and rendered them. At 390×844 the same API returned two rooms and the DOM contained both, but `aside.isVisible()` was false; People → Conversations changed it to true. This falsifies the empty API/cache hypothesis for the reproduced case. `AppShell` initialized `sidebarOpen=false`; CSS below 760px hides the sidebar unless `.is-open`. The Conversations button opened it, while initial `/` navigation did not.

Home now opens the mobile drawer; room navigation closes it. A separate verified failure path was a room query error with no error UI. Added bounded retry and an explicit Retry control, tested by returning 503 on all attempts then restoring the API.

## Notification design and review

Existing room.activity is insufficient for sound: it also targets senders and does not encode DND/mention-only eligibility. EVT-063 is a small content-free user event emitted by NotifyMessage after the existing PushDecisionService decision, even without a mobile push token. In-app room invitations/session revocations also emit it; mentions use the message alert once. Sound=false and DND remain authoritative on the server. Corrected overnight DND weekday ownership with a Monday-night/Tuesday-morning regression.

Browser AudioContext unlocks only on trusted interaction. Shared NotificationGate deduplicates IDs and limits bursts; focused visible rooms suppress message sound. Blocked audio is dropped, never replayed. Notification center persists the sound preference through existing API-072. Title sums API-008 total_unread across all workspaces, retaining canonical mute rules and clearing on logout.

Scrutinize trace: login → route → responsive CSS; notification job → eligibility → private user channel → dedup/focus gate → Web Audio; read receipt → workspace invalidation → session workspaces → title; preference update → persistence → next notification job. No REST wire change; corrected existing /me client type to include already-present settings. No migration.

## Validation

- Full isolated API suite: 346 passed, 2 existing skipped; 1,550 assertions.
- Shared/api-client/chat-core/mobile: 129 tests passed (3 + 6 + 81 + 39).
- Web TypeScript/build passed; existing large bundle warning remains.
- `verify.mjs`: eight browser checks with isolated users/workspace, actual API and Reverb: initial mobile rooms, audible new message + title, focused silence/read-clear, muted silence, persisted toggle/reload, fetch error/retry, logout title, no runtime errors. Audio verified at actual oscillator start, not by a human listening to speakers.
- First browser run exposed test assumptions: group system event occupies sequence 1, so canonical unread after first user message is 2; focus established with a real composer click; controlled async checkbox awaited after click. Final run passes; no app behavior changed to satisfy these assumptions.
- Core test red before implementation: missing notification module; then 81 core tests green.

Browser sound requires an open app and browser audio support/permission; it does not provide notifications after the browser is closed. Desktop production did not reproduce the original list issue; confirmed fix targets the reproduced responsive case.

Production verification is recorded in production-results.json after deployment. Backups and image rollback tags are retained on the server under login-notifications-20260911.

## Production outcome

Deployed runtime commit 39a1ad3 to https://chat.gamecoms.net using an incremental checked patch, rebuilt api/worker/scheduler/reverb/nginx and recreated those services. All nine services healthy; health endpoint reports database/Redis/storage/Reverb/queue OK. Five production browser checks passed with tony → tony2: first-login mobile room visibility, actual Web Audio oscillator + unread title on message, title reset after reading, persisted preference control visible, zero JavaScript errors. QA message is explicitly labeled. Both QA sessions signed out. Production preferences were not changed by this smoke test.

Production harness correction: footer includes a decorative star, so exact text lookup was invalid; changed assertion to contain the connection text. This was a test selector issue, not a runtime failure. Local isolated review container/database removed after validation; production backup and rollback images retained.
