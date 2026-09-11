# FR-KAN-006 — ticket images and Markdown editor

TASK-BE/WEB/CORE/QA-044 · API-145..147 · DEC-055 · TC-KAN-010..015

Tickets accept up to 20 ordered images, with upload feedback, add/remove controls and the existing image viewer. The description has Markdown formatting controls, Cmd/Ctrl+B/I and a safe rendered preview. Existing workspace membership, assignment, deadlines and optimistic version checks remain the mutation boundary.

## Review

Reusing the current attachment upload/processing pipeline and Markdown renderer avoids a second storage or HTML rendering system. Traced upload → processing → versioned BoardService transaction → ordered pivot → serializer → gallery/viewer. New images require the actor's ownership and workspace, and cannot already belong to a ticket, message or note. Existing ticket images may be retained or removed by another workspace member. Missing attachment_ids preserves images; [] clears them. Removed images are soft-deleted and queued for purge after 24 hours. Message and note writes also reject ticket-owned images under their existing attachment locks. History records image ID changes.

Admin lane management is unchanged; this work adds ticket capabilities in the member board, not a new admin ticket resource.

## Validation

- API: **384 passed, 2 skipped, 1793 assertions**. Includes existing Kanban, media, notes, messages, calls, meetings and admin suites.
- Unit suites: **136 passed** (shared 3, api-client 6, chat-core 88, mobile 39).
- Workspace typecheck, web build, targeted oxlint, Pint and OpenAPI YAML parsing pass. Existing build chunk size advisories remain.
- Browser script `verify.mjs`: real image bytes through upload/processing, three images saved/reopened, loaded image dimensions checked, viewer, Markdown toolbar/preview/rendering, another member preserving/removing/adding images, bad-file recovery and 390px mobile layout.
- TC-KAN-010: multiple-image persistence, omitted/empty replacement, peer edits, history/version conflict and isolation.
- TC-KAN-011: foreign owner/workspace, reused, deleted, failed/pending, duplicate and excessive images rejected.
- TC-KAN-012: pure Markdown selection transforms, multiline formatting and Unicode.
- TC-KAN-013: browser workflow above; results and screenshots alongside this report.
- TC-KAN-014: attachment ownership exclusive in both directions with messages/notes.
- TC-KAN-015: undecodable image bytes fail processing.

## Image decoding fix

A `.png` upload containing `not an image` was marked Ready. UploadService's generic binary fallback allowed completion, and ProcessAttachment::processImage returned successfully when GD could not decode the bytes. The caller then set Ready. The fix throws on failed raster decoding, allowing the existing failure event/status path to run; HEIC/HEIF passthrough remains unchanged.

The new API test failed before the fix and passes after it. The browser now shows the failure, disables Save until it is removed, and allows retry. An existing antivirus test used text bytes while declaring kind=image; its fixture now uses real PNG bytes so it still verifies image scan bypass without relying on invalid decoding. Local production-image PHP serving cached source until restart; the final browser run used the restarted runtime and confirmed the failure path.

## Deployment

Production backup prepared at `/root/banana-chat-backups/kanban-images-20260911`; previous images tagged `before-kanban-images-20260911`. Additive `kanban_ticket_attachments` migration; no existing ticket data rewritten. Production runtime delta is applied over the current server working tree, preserving unrelated changes. Server OpenAPI has preexisting divergence and is excluded from runtime patching; test sources absent from the production checkout are also excluded. The repository contract and tests are updated.

Deployed feature commit `0e9fccb` to https://chat.gamecoms.net. Migration completed and all application health checks passed. Production browser verification passed all five scenarios, including loaded image dimensions and the real MinIO/worker pipeline. Both local and production results/screenshots are attached. Temporary production QA members/workspace and uploaded objects were removed successfully by the script cleanup.
