# Test report: Public Chat group rooms (FR-PCHAT-040..043, DEC-104/105)

Date: 2026-11-02

## Results
| Suite | Result |
|---|---|
| Pest, public-chat (GroupRoomTest + existing) | 138 passed |
| Vitest, packages/chat-core (incl. public-chat-group) | 365 passed, 31 files |
| `tsc --noEmit` (apps/web) | clean |
| Playwright UI, `public-chat-group.spec.ts` (TC-UI-PCHAT-001..010, 16 runs) | 16 passed |
| Playwright UI, call-audio / call-avatar / call-message / room-tools (touched MediaPanel + calls.css), combined with the above | 48 passed |
| Vitest, packages/shared | 3 passed |

## Not passing, not caused by this work
- `chat-ui.spec.ts` TC-UI-001/012 (x3 widths) and TC-UI-009: 4 failures. Same 4 fail with this round's uncommitted changes stashed.
- Pest `PushTest` TC-NOTI-026: fails on its own; not investigated.
- Pint: 9 style issues in 9 files (8 not edited by this work).

## Real defects the UI tests found and fixed
1. Dialogs rendered stuck at top-left (global CSS reset breaks native dialog centring).
2. Mobile dialog was 352px wide instead of full width (UA max-width).
3. Pre-join microphone defaulted ON; now off.
4. A "device access unavailable" line was always shown; removed.

4. Queue row for a group room collapsed (buttons.css forced a 40px button height; content overflowed and badges overlapped). Fixed, TC-UI-PCHAT-009.
5. Raw key `pchat.status.open` shown on the row: added en/th label.
6. Room link was hidden behind a menu: header now has Copy link, and the Room tools drawer shows the link in a read-only field (TC-UI-PCHAT-010).

## Limits
- Playwright runs against mocked API routes. No real backend, no real LiveKit; video join has not been exercised end to end.
- No presence roster or device pickers.
- Anyone with the password can claim any guest name (DEC-104).

## Screenshots (this folder)
Create dialog: pchat-create-desktop-{light,dark}, pchat-create-mobile-{light,dark}, pchat-create-filled, pchat-create-success.
Guest gate: pchat-gate-desktop-{light,dark}, pchat-gate-mobile-{light,dark}, pchat-gate-wrong-password.
Queue row: pchat-list-{desktop,mobile}. Room page: pchat-room-copy-link, pchat-room-tools-link.
Chat: pchat-chat-desktop, pchat-chat-mobile. Video pre-join: pchat-prejoin.
