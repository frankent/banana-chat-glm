# TASK-ADM-015 / FR-READ-001 — administration and unread

## Unread experiment ledger

1. Production replay after opening a DM with eight images: unread remained 2. Browser focused and visible; scrollTop 2043, scrollHeight 3693, clientHeight 570. The last message was 1080 px below the viewport.
2. Explicit window/composer focus: still unread 2. This falsifies a focus-only explanation.
3. Explicit scroll to bottom: unread 0. API/receipt pipeline works when the sentinel is visible.
4. Same replay reserving the known 180 px image heights before navigation: unread 0 on opening, scrollTop 3184 / scrollHeight 3754 / clientHeight 570. Only media layout changed. Confirms late image sizing displaced the bottom sentinel.
5. Fix reserves image/video aspect ratio and bounded dimensions using server metadata. No blanket mark-read on room open; reading older history/search retains its read boundary.

## Administration scope

Keep Filament and existing admin guard, TOTP and provider workflows. New overview, grouped navigation, green/cream theme with dark/mobile variants. Add rooms, message/history moderation, notes, shared pin removal, attachment retry, sessions/devices, operations/storage, all runtime settings and privacy-gated AI conversation inspection. Feature directory enumerates the actual registered API routes and points to the corresponding administration surface or member application. Sending messages, typing, personal notification preferences, AI regeneration/consent/memory remain member-owned operations; admin does not impersonate members or bypass consent.

During review, fixed discarded audit CSV response, incorrect user-side membership AttachAction, lack of cascading room removal/owner transfer on workspace removal, raw hard-delete account button, and Horizon's guard mismatch. Mutations are audited and preserve existing realtime contracts. No database migration.

Regression uses the dedicated `orgchat_test` database; browser fixtures use `orgchat_review_20260911`. Never reset the development or production databases. An initial browser run used request-local array cache, breaking refresh-token replay grace across requests; rerun with Redis matching production.

The first broad API run was invalidated by accidentally starting a second test process against the same isolated test database. It observed missing test tables; no development or production data was affected. The authoritative rerun is serial. Browser regression runs are also repeated after web edits settle to avoid HMR changing auth module state mid-run.

Validation so far: 127 shared/client/core/mobile automated tests passed, web production build passed. Full API suite: 337 passed, 2 skipped, one new test used the wrong login envelope (`data` versus the endpoint's root response). Fixed the test and reran the expanded administration suite: all 21 passed. This includes actual Livewire mutation and file-download assertions. Chat browser regression: 19 passed; history-read test explicitly focuses the target tab before SPA navigation, matching actual member interaction.

Final local verification: all 48 administration tests passed (301 assertions), all 20 browser chat checks passed, including eight delayed images with unread=0 and bottom gap=0. All 17 administration pages and mobile overflow check passed without runtime errors. TC-WEB-041 is the final ID of the delayed-media check (initial runner label TC-READ-012 was renamed to avoid a catalog collision).
