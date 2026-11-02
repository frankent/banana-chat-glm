# Test report: Public Chat group rooms (FR-PCHAT-040..043, DEC-104/105)

Date: 2026-11-02

## Results
| Suite | Result |
|---|---|
| Pest, public-chat (GroupRoomTest + existing) | 138 passed |
| Vitest, packages/chat-core (incl. public-chat-group) | 365 passed, 31 files |
| `tsc --noEmit` (apps/web) | clean |
| Playwright UI, `public-chat-group.spec.ts` (TC-UI-PCHAT-001..008, 13 runs: 4 viewport/theme variants x 2 + 5 single) | 13 passed |
| Playwright UI, call-audio / call-avatar / call-message / room-tools (touched MediaPanel + calls.css) | passed (68 passed in the combined run) |

## Not passing, not caused by this work
- `chat-ui.spec.ts` TC-UI-001/012 (x3 widths) and TC-UI-009: 4 failures. Same 4 fail with this round's uncommitted changes stashed.
- Pest `PushTest` TC-NOTI-026: fails on its own; not investigated.
- Pint: 9 style issues in 9 files (8 not edited by this work).

## Real defects the UI tests found and fixed
1. Dialogs rendered stuck at top-left (global CSS reset breaks native dialog centring).
2. Mobile dialog was 352px wide instead of full width (UA max-width).
3. Pre-join microphone defaulted ON; now off.
4. A "device access unavailable" line was always shown; removed.

## Limits
- Playwright runs against mocked API routes. No real backend, no real LiveKit; video join has not been exercised end to end.
- No presence roster or device pickers.
- Anyone with the password can claim any guest name (DEC-104).

## Screenshots (this folder)
Create dialog: pchat-create-desktop-{light,dark}, pchat-create-mobile-{light,dark}, pchat-create-filled, pchat-create-success.
Guest gate: pchat-gate-desktop-{light,dark}, pchat-gate-mobile-{light,dark}, pchat-gate-wrong-password.
Chat: pchat-chat-desktop, pchat-chat-mobile. Video pre-join: pchat-prejoin.
