# Chat UI production verification - 2026-09-11

Deployed to https://chat.gamecoms.net. The candidate and public production build each passed 34 Playwright checks. Both runs reported zero browser runtime errors and removed their isolated QA workspaces, accounts and uploaded objects. The exploratory QA workspace was also removed.

## Fixed

- Message actions disappeared during pointer movement from the hovered message row toward its floating toolbar. Replaced hover-only access with an explicit, persistent menu that supports outside-click dismissal and Escape.
- Keyboard users could not reach hidden actions, and touch tablets wider than 760px had no hover affordance. Added a keyboard-reachable menu toggle, focus restoration, named edit/delete buttons and direct touch controls at all widths.
- The mobile room filter used its longest option's intrinsic width: its right edge was 398px on a 320px screen. Constrained the filter and search form controls to their container.
- Images sent before processing finished remained spinners. Production returned uploaded initially, then ready, and emitted attachment.ready, but the chat retained the old attachment object; reload displayed the image. AttachmentView now refreshes processing metadata until ready/failed, with account/workspace-scoped query keys. Both sender and recipient now display the image without reloading.

Requirements: TASK-WEB-018, FR-MSG-005/006, FR-SRCH-001/002, FR-MEDIA-004.

## Evidence and experiment ledger

| Run | Observation | Conclusion |
| --- | --- | --- |
| Baseline UI sweep | An immediate post-edit pin test timed out | Not sufficient evidence of a pin API bug |
| Settled edit control | Waiting for edit form dismissal made pin/jump/unpin pass | Original pin failure was a test timing issue |
| Baseline pointer trace | Pointer crossed outside the message row before reaching the toolbar; display became none | Hover lifetime caused disappearing actions; a small CSS bridge did not fix it |
| Keyboard and touch baseline | Keyboard skipped message actions; tablet hover:none hid them | Existing hover and width rules prevented access |
| Mobile search baseline | Filter right edge 398px at viewport width 320px | Intrinsic select width caused clipping |
| First candidate | 30/31 checks passed; image preview remained processing | Broader real upload test exposed another existing defect |
| Image disproof | API ready, attachment.ready received, UI spinner; reload shows image | Worker and image bytes work; displayed metadata is stale |
| Final candidate | 34/34 passed | Fixes work against real production services before release |
| Public production | 34/34 passed | Same checks pass after release, without asset routing |

See baseline/, candidate/, candidate-final/results.json and production/results.json. Screenshots include responsive chat, mobile search, tablet touch controls and mobile calls.

## Coverage and limits

Chromium desktop, keyboard navigation, touch emulation and widths 320, 390, 760, 768, 820, 1024 and 1440. Tests cover DM/group creation, realtime messages, edit/cancel/delete, reply/cancel/jump, pin/unpin, drafts, Enter/Shift+Enter, mentions/typing, notes, text/image uploads and viewers, download links, media filters, sidebar navigation, notification sound, and voice/video join, microphone/camera toggles, minimize/expand, decline, leave and end-for-everyone.

Call checks use Chromium's synthetic camera/microphone with real signaling and media transport. Physical devices, operating-system screen-share pickers, Safari/Firefox, AI responses, pagination at large history sizes and every network-error state are not certified by this run.

## Deployment

Only the frontend nginx image was rebuilt/recreated; TypeScript and Vite production builds passed. No migrations or environment changes were needed. Vite retained its existing large-chunk warning.

Image/container: sha256:65d09986247e7885416a98f0b93ef05fd7bdb7da30d5087f40a0f34183ab350f running healthy

Rollback image: banana-chat-ui-rollback:20260911. Source backup: /opt/banana-chat-ui-backup-20260911/source.tar. The rollback image was retained; the temporary candidate container was removed after verification.

The user's instruction to deploy completed changes to this production server is recorded in the repository's AGENTS.md. Credentials are not stored in the repository.

## Rerun

Run verify.cjs with an authenticated SSH control socket in CHAT_UI_SSH_SOCKET. It creates and cleans up unique QA fixtures. CHAT_UI_PLAYWRIGHT_PACKAGE and CHAT_UI_CHROMIUM can point to an external Playwright installation and browser. CHAT_UI_RUN chooses the output folder. For a pre-release image, CHAT_UI_ASSET_ORIGIN serves candidate documents/assets while the browser retains the production origin and uses real production APIs and WebSockets. Omit that variable for public-production verification.
