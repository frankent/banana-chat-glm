# Room collaboration — DEC-048 / TASK-BE-040 / TASK-CORE-040 / TASK-WEB-040

Implemented the requested Conversations navigation fix, paginated workspace directory with DM entry, room Notes with media, shared pinned-message jumps, named typing, persisted inline replies, Markdown bubbles/file previews, image/video viewers, compact author grouping, and explicit-mention group AI.

## Debug ledger

- Reproduced TC-WEB-040: at `/search`, Conversations changed only `sidebarOpen`; URL stayed `/search`. Existing DM and mobile drawer checks passed, ruling out a broken button or routing infrastructure. The button lacked navigation.
- Fix: navigate to the conversations home and open the drawer; keep drawer open when entering home, close on room navigation. Browser regression checks desktop and mobile.
- New API tests initially failed at missing endpoints, then passed after implementation.
- Reply/pin browser check initially matched both an original message and its quoted reply. Restricted the locator to the original; this was test ambiguity, not a second product defect.

## Scope and behavior

Notes have no count limit, paginate 30 at a time and use existing attachment upload limits. Text is capped at 20,000 characters per note. Members create/read; author and admins edit/delete. Pin/unpin is shared for current room members. Reply target and attachment IDs persist through the existing outbox.

AI is a virtual participant in every group. `@ai` on a newly sent message triggers a queued reply; ordinary messages, edits and DMs never invoke it. Only mention text is sent, without room history, attachments or private memory. Existing provider/workspace/consent gates and daily quota apply. Bot accounts cannot sign in. Provider error details and credentials are not posted in rooms. This increment does not add native mobile screens.

Markdown supports the existing safe GFM subset and HTTP(S) autolinks; raw HTML remains escaped. Text-file preview is limited to 1 MB, with download for larger files. Image zoom/fit and browser video controls are provided in an accessible native dialog.

## Verification

See `results.json` for isolated live-browser checks. Tests use the separate `orgchat_review_20260911` database/API on port 18000 and temporary users. Ready media fixtures verify actual image/text/video loading independently from media-processing workers. API tests use forced `orgchat_test`, not development or production data.

API contract additions are in `apps/api/openapi.yaml`; typed endpoint wrappers are maintained manually in this repository (no `gen:client` command is configured).

Validation completed: 19 browser cases passed, 127 workspace unit tests passed, all workspace TypeScript checks and web production build passed. API full suite: 318 passed / 2 skipped; after the final attachment-delete guard and DM bot test, the targeted room-tools/upload suite passed 33 cases. Existing large-bundle build warning remains.

## Production deployment

Deployed runtime commit `b4b476f` to https://chat.gamecoms.net, preserving the existing production patches. Added the Notes/Pin tables without modifying existing conversation data. Previous images use the `before-room-tools-20260911` tag; database dump, original patch and build logs are in `/root/banana-chat-backups/room-tools-20260911/` (root-only).

An initial deployment permission fault caused PHP login requests to fail: the restrictive backup umask carried into patch application, leaving source files mode 600. Restored runtime source permissions to 644, rebuilt/recreated the API/worker/scheduler/Reverb images, and verified readable permissions and live authentication. Health checks alone had not detected PHP bootstrap failures.

Live verification covers login/WebSockets, background message/unread, workspace badge, open-room receipt, Conversations navigation, directory→DM, Notes realtime create/delete, named typing, Reply, Pin/jump/unpin, responsive UI, and a real queued AI-provider reply to @ai in a private test group. The test group is deleted afterwards. `verify-production.mjs` accepts only the test-account password on stdin and logs out its sessions; it creates clearly labeled QA messages. See `production-results.json`.
