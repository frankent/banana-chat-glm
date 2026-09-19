# Calm Banana — implementation and verification

Date: 2026-09-19. Base: `4097d2e`. Fix location: current working tree (not committed or deployed by this session). Classification: LARGE / MEDIUM risk (scrolling, read state and shared CSS); root owned PO/technical decisions and implementation, native specialists owned independent browser QA and source review. Scope: web chat list, bubbles and timeline in `PLAN_ASTRA.md`; decision `DEC-078`.

## Result

Reworked the chat hierarchy, spacing and surfaces around a white conversation list, neutral timeline and pale-yellow outgoing messages. Mobile conversation uses the whole screen with Back navigation. Chat tools and labelled message actions have a single entry point; the action dialog traps focus, closes on Escape and confirms deletion. Search/filter state survives returning to the conversation list. Thai/English strings cover the new controls.

Timeline now preserves a visible message and its pixel offset across history prepend, incoming messages, height-changing edits and ResizeObserver reflow. History fetches are single-flight, show errors/retry and cannot update another room's pagination state. Quote jumps highlight, return to the previous offset, and keep read receipts gated. Sending from history exits anchor mode. The live-arrival callback stays stable through anchor changes so the shared typing/notes/pins channel is not discarded. New-arrival badges count live incoming events rather than fetched historical pages; loaded duplicates, own messages and system events do not inflate the count.

## Debug record

| Observation / hypothesis | Evidence and mechanism | Correction |
| --- | --- | --- |
| Closed touch menu caused excess bubble height | Current-source Chromium baseline measured hidden actions at 44px: `visibility:hidden` plus mobile `position:static` preserved layout. Differential `display:none` reduced that box to 0px. | Render actions only when open, in a portal dialog; no closed toolbar box. |
| A stale build might explain the poor layout | Reproduced with current Vite source and synthetic fixtures, independent of deployed bundles. | Diagnose source cascade rather than assume deployment cache. |
| Cached conversations disappear after transient refresh error | RoomList exclusive `isError` branch replaced successful cached rows. UI test forces subsequent 503. | Keep cached navigation alongside retry notice. |
| Reply destination has no reliable visible highlight | Attribute was on outer row; CSS selected inner `.bc-message`. Message updates also cancelled the timer via effect cleanup. | Match row selector, independent expiration effect, reset before jump; repeat cached jump tested. |
| Mobile header title collapsed during this correction | Screenshot review caught title width 0; old `#root .bc-chat-header > div:last-child {width:100%}` won specificity over new actions width. | Stronger scoped header selector, bounded Back flex and text flex. Test asserts title width and visible tools, not just absence of page overflow. |
| Scroll math based on total height moves the reader | Prepend plus incoming changes both ends; edits/media change heights without message count. | Capture seq+pixel offset and restore after render/reflow. Browser fixtures assert ≤4px drift. |
| Late older-page response can hide new room's history | Hook returned false for stale generation, but old ChatView `.then(setOlderRemaining)` still modified the newly selected room. | Own pagination state inside generation-guarded hook; delayed A→B regression. |
| Sending from anchor sometimes stopped above latest | Larger body text exposed a timing failure: delivered seq41 existed and URL cleared, but bottom gap was64–249px. Clearing the jump guard before the URL transition allowed old anchor effects to run again; queued old scroll events could cancel bottom intent. | Preserve jump guard until next explicit target; apply explicit anchor→latest intent after the URL/outbox DOM commit. Selected regression passed3 repeated runs after correction. |
| Body text remained too small despite wrapper tokens | Legacy `.bc-message-bubble p.whitespace-pre-wrap` set paragraph 13px independently of wrapper. | Explicitly inherit chat body 15px desktop /16px mobile; metadata 12px. |

The previous verification did not assert closed-menu geometry or the painted highlight. This session's initial reflow checks also missed the collapsed title until screenshots were reviewed. Tests now cover both computed geometry and visible output. No claim is made about the earlier author's intent.

## Verification

Executed from the package directories using Node because `pnpm` is unavailable on this shell's PATH:

- `packages/chat-core`: `node --run test` — **221 passed**, 22 files.
- `apps/web`: `node --run typecheck` — passed.
- `apps/web`: `node --run build` — passed; Vite warns about existing >500kB chunks.
- `apps/web`: `node node_modules/@playwright/test/cli.js test --config playwright.config.ts e2e/regression/web.spec.ts --grep 'login →|realtime —|search page'` — **3 passed** against local Vite/API/Reverb: login/send, second-browser realtime receipt and search.
- `apps/web`: `node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts` — **16 passed (48.0s)** in the full UI run; after the final stable-subscription patch, targeted typing/send-from-anchor/new-count regressions **3 passed (9.2s)**. The suite now contains17 unique cases; a full17 run is not claimed. API and WebSocket data are synthetic. This is not production/backend acceptance.
- Targeted `oxlint` over changed source + `e2e/ui` + `playwright.ui.config.ts` — exit 0, React hook/effect advisory warnings remain. Full `node --run lint` fails on two pre-existing `react-hooks/rules-of-hooks` errors in `e2e/regression/fixtures.ts` (Playwright's `use` callback), plus warnings. No unrelated lint cleanup included.
- Final test-harness TypeScript and oxlint both exited0. The new count test initially raced its own programmatic scroll assignment; it now waits for the visible away-from-bottom control before emitting the incoming event.
- Independent native agents performed browser QA and source review. Prior MEDIUM findings were corrected; final source review reported no HIGH regression. The last bounded review confirmed the stable callback resolves the shared-channel regression. Claude/OpenCode were not invoked or represented as reviewers for this correction.

Screenshots (ignored test artifacts, synthetic content):

- [Desktop](apps/web/e2e-artifacts/ui/screenshots/conversation-1440.png)
- [Mobile 390](apps/web/e2e-artifacts/ui/screenshots/conversation-390.png)
- [Mobile 320](apps/web/e2e-artifacts/ui/screenshots/conversation-320.png)
- [Mobile list](apps/web/e2e-artifacts/ui/screenshots/conversation-list-mobile.png)

## Acceptance limits and follow-up

Implementation/automated verification is separate from customer approval. TASK-UI-008 remains open: no customer usability session or real iOS/Android keyboard validation was performed. Desktop Chromium emulation does not establish Safari/native acceptance. No new production rollout was performed; do not infer live-site changes from local screenshots.

Native Expo parity, authoritative first-unread landing, sticky date and benchmark-led virtualization remain P1. Attachment/media variants, browser zoom/reduced-motion/screen-reader audit, real delayed-image reflow and non-chat shared-consumer visual acceptance need the broader release checklist. ResizeObserver is implemented; current deterministic height-change evidence uses message edits, not every media decoder/device.

The new chat geometry lives in `chat.css` after legacy `index.css`/`buttons.css` to avoid changing unrelated screens. Remaining legacy chat selectors should be consolidated only with shared-consumer coverage. Saved positions whose messages have been evicted from memory still need an explicit fallback UX. Receipt and message authorization remain server-owned.

## Staging alignment investigation — 2026-09-19

User reported all bubbles aligned left on `chat.cloudnds.com`. Logged in with the explicitly authorized account using fresh Chromium sessions. Read receipts and non-auth API writes were intercepted; no chat messages were sent. Credentials, tokens and message contents are not included in this record.

**Status: not reproduced; no alignment implementation fix or deployment claimed.** Checked all four available rooms across two workspaces at1440,390 and320 CSS px. One room only contained a system message. The remaining rooms had respectively30/36,45/55 and2/3 own/other rendered messages in the loaded histories. Own rows had `data-mine=true`, computed `justify-content:flex-end`, and bubble right gap≤2px; other rows aligned left (allowing the desktop avatar gutter). No alignment failures were observed at any checked width. Staging DOM still matches the earlier UI, not this session's undeployed redesigned bubbles.

Evidence ledger: initial default workspace inspection found only a system event, so it could not test ownership alignment. Switching workspaces exposed normal conversations. Browser DOM/computed-style inspection showed correct ownership flags and geometry. A temporary CSS-only `justify-content` override did not change the already-right-aligned own bubble (right gap0 before/after), so that run does not support a missing alignment rule. Expanded room/viewport checks also passed. Exact affected room, device/browser or screenshot is still required to reproduce the reported state; fresh-session success does not rule out a state-dependent problem in the user's session.

Added geometry assertions to the existing responsive fixtures: own seq40 and other seq39 must have correct ownership, every outgoing bubble must meet the right edge, incoming bubbles must meet the left/avatar edge. `node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts --grep 'conversation reflows'` — **3 passed (8.1s)**. `node node_modules/oxlint/bin/oxlint e2e/ui/chat-ui.spec.ts` — exit0. These local tests are synthetic and distinct from the staging inspection. No independent agent was needed for this focused reproduction/test-only follow-up; the implementation remains unchanged pending reproduction.


## Visual refinement — beauty-first pass, 2026-09-19

User redirected priority from investigating alignment to visual quality. Scope MEDIUM / LOW risk: root owned design and presentation edits; a native independent reviewer inspected before/after screenshots. No messaging, session, scrolling or API behavior changed in this pass.

- Compact intrinsic-width filter pills with a quiet sage selected state; selected conversation retains a pale-yellow surface and a small edge indicator.
- Softer neutral timeline/bubble borders, slightly rounder bubbles and tighter timestamp spacing; message typography stays15px desktop/16px mobile and metadata12px.
- Frameless44px mobile Back; rounded composer, subdued sage focus indicator and circular send button with distinct enabled/disabled states.
- Conversation-list titles/previews now15/13px; mobile filters retain44px touch height.
- Message times use the app locale (Thai24-hour formatting). No timestamp data/timezone conversion changes.
- Self-hosted original Noto Sans Thai regular/semibold assets (~40KB each) plus OFL notice in `apps/web/public/fonts/`; Thai rendering no longer depends on that font already being installed on a device. Existing Latin font loading is unchanged.

Validation: `node --run build` in apps/web passed (existing bundle-size warning). Full `node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts` **17 passed (49.3s)** on this revision, including explicit left/right geometry and typing-after-quote regression. `git diff --check` passed. Independent visual review of1440/390/320px conversations and mobile list found no blocking visual regression; root also reviewed the refreshed screenshots. Source-colour contrast calculations: filter text8.13:1, enabled send icon8.85:1; this is not a complete accessibility audit.

Updated preview links above point to the current screenshots; previous visual pass preserved under ignored `apps/web/e2e-artifacts/ui/before-polish/`. This pass remains local, not deployed. Customer aesthetic acceptance and real-device keyboard validation remain open.


## Bubble refinement from supplied photo — 2026-09-19

The user supplied a mobile staging photo showing short messages inside tall boxes with large blank areas. That photo shows the old header/rail/action layout, not the undeployed local design. This focused SMALL/LOW-risk pass refines the local message proportions further: short plain text (up to60 characters, no attachments, deleted state or editor) displays metadata inline; longer/richer messages retain block metadata. Reply quotes use a compact inset, sender label and minimum44px click target. No send/read/ownership behavior changed.

New synthetic Thai fixtures model short text and incoming/outgoing replies without copying private chat content. `bubble-visual.spec.ts` asserts short outgoing height<55px, quoted bubble height<130px, quote target44–70px and bottom blank space<12px. Previews: [mobile](apps/web/e2e-artifacts/ui/screenshots/bubbles-390.png), [desktop](apps/web/e2e-artifacts/ui/screenshots/bubbles-1440.png).

Executed in apps/web: `node --run build` passed; `node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts` **19 passed (54.3s)**; `node node_modules/oxlint/bin/oxlint e2e/ui/bubble-visual.spec.ts src/components/MessageItem.tsx` exit0. Independent native visual review and root screenshot inspection found no blocking regression in the pictured states. No staging deployment performed; customer visual acceptance remains open.
