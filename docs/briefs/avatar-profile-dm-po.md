# Brief (PO): Click an avatar in a room -> profile popup -> "Message" (1-1 chat, reuse existing DM)

Status: DRAFT for Tech Lead. Proposed IDs: FR-PROF-009 (popup), FR-ROOM-001 amended (entry point), DEC-101 (next free DEC), TC-WEB-PROFPOP-*, TC-ROOM-1xx. No new API strictly required (see Q1).
Base: main d2abbe4. Everything below was checked in code; spec line numbers are PRODUCT_SPEC.md.

## 1. Requirement (restated)
1. In a chat room, clicking/tapping a member's avatar opens a small profile popup.
2. The popup has a "Message" button that opens a 1-1 chat with that person.
3. If a 1-1 chat with them already exists, go to that room; never create a second one.

## 2. Confirmed current state (with file:line)

### 2.1 Where avatars render in a room (web) - only ONE is a candidate
- Message list sender avatar: `apps/web/src/components/MessageItem.tsx:432`, `{!mine && showSender && <Avatar .../>}`. `showSender` is `room.type !== 'dm'` (`ChatView.tsx:488`), so it renders in GROUP rooms only, never in DMs, never for my own messages. Grouped consecutive messages keep the node but hide it (`index.css:315` `visibility:hidden`).
- PREMISE RISK: at max-width 760px the avatar is `display:none` (`index.css:278`). On a phone-width browser there is NO avatar in the message list to click. Desktop-only unless we change that (see Q3).
- Sender name `<p>` above the bubble (`MessageItem.tsx:435`) is plain text, not clickable.
- NOT a click candidate / not in scope of "in a room": chat header avatar (`ChatView.tsx:384`, already the DM peer; in groups it is the group-photo editor button, `:383`); room list (`RoomList.tsx:23`); read-receipt dialog rows (`ReadReceipt.tsx:80`); reactors dialog rows (`MessageItem.tsx:143`); composer @mention autocomplete (`Composer.tsx:287`, selecting is an insert action); call tiles/ringing (`CallTile.tsx:57`, `CallProvider.tsx:173`); account menu (own avatar, `AppShell.tsx:169`).
- Rendered @mentions are plain markdown text, no chip/avatar. Typing indicator is names only (`ChatView.tsx:528`). System messages (`member_added`, `member_left`, ...) are text strings with no avatars (`MessageItem.tsx:44-58`).
- There is NO room member list/panel on web. Only: add-members picker, read-receipt list, reactor list.
- Mobile (Expo): room screen shows NO avatars at all, only a sender name Text (`apps/mobile/app/room/[id].tsx:316`). Mobile can start a DM only from the directory (`apps/mobile/app/members.tsx`, `openDm`). Spec (`:835`) already says Expo trails web for UI.
- Public-chat (support) visitor pages and agent pages are a separate system (`PublicChatPublicSerializer`, FR-PCHAT-014); they use no `MessageItem` avatar and have no user ULIDs on the visitor wire. Not affected.
- AI Assistant view (`components/ai/*`) is a user-private conversation, not a room. Not affected. The in-room AI bot ("@ai") is a user row `__banana_ai_bot__`, status `deactivated` (`GenerateRoomBotReply.php:305`); its replies render with an avatar in groups, so it IS clickable in the list unless excluded.

### 2.2 Profile data that exists
- A user has: username, display_name, avatar (sm/md/animated), status (active/suspended/deactivated), last_seen_at, locale, timezone, is_system_admin (`UserResource.php`; `User.php:42-54`). There is NO email, NO title/department, NO phone, NO status text (FR-PROF-002 is P2, unbuilt). Usernames are admin-assigned login ids.
- Message sender payload: `id, username, display_name, avatar_attachment_id, avatar` only (`MessageSerializer.php:43-52`). Enough to render a popup with zero extra requests.
- Room members (`GET /rooms/{id}/members`, `RoomController.php:412-452`): + `role` (room), `joined_at`, `presence`. Directory (`GET /members`, `WorkspaceController.php:50-125`): + workspace `role`, `presence`, `last_seen_at`. Presence is already shown to every workspace member, so showing it in the popup adds no new exposure.
- Web already caches the room roster (`ChatView.tsx:118`, key `room-members`) for mentions and reply names.
- No existing profile popup/card/member sheet on web or mobile. The only "people" surface is the directory page (`pages/MembersPage.tsx`, FR-WS-005, `:20` click row = start DM).
- PRIVATE, must NOT appear: `last_seen_at` exact timestamp is already public in directory, but recommend popup shows coarse presence only (online/offline). Never show: locale, timezone, is_system_admin, must_change_password, login/lock state, suspended-vs-active distinction, device/session info, room-private data (their read position, mute, hidden), other workspaces they belong to. Workspace role label (owner/admin/member) is already in the directory; OK to show.

### 2.3 How DMs are created today (idempotent already)
- `POST /api/v1/rooms {type:'dm', user_id}` (`RoomController.php:104-143`; client `packages/api-client/src/endpoints.ts:305` `createDm(userId, slug, secret?)`). Returns 200 + existing room or 201 + new (`:142`). Used by web directory (`MembersPage.tsx:23`), new-room dialog, and mobile `members.tsx`. So requirement 3 needs NO server change for the common case.
- Dedupe: `dm_key = sha256(sorted(userA,userB))`, unique column (`CreateRoomAction.php:157-165`; migration `rooms.dm_key` unique `:18`). Secret DMs use a `secret:`-prefixed key (separate namespace, DEC-056), so an avatar-click DM never lands in a secret DM.
- Race: insert violation is caught and the other party's room returned (`CreateRoomAction.php:67-72`). Server-side double-click safe. Two web clicks -> two POSTs -> same room, one 201 + one 200. Only a client "busy" guard is needed for UX (MembersPage does `busy`).
- Returned room is navigable immediately (`navigate('/rooms/'+id)`). A DM the caller had HIDDEN (`room_members.hidden_at`) is returned as is; hidden_at is cleared only when a message is sent (`MessageWriter.php:143`). So "go to existing DM" works but the DM may not be in the default room list until first message. Acceptable; see AC-9.
- Self: `422 ROOM_DM_SELF` (`CreateRoomAction.php:35`, FR-ROOM-001). Target must be an ACTIVE ws member and user status != deactivated, else `404` (`:38-51`, no leak).
- Room types: only `dm` and `group` (`Enums/RoomType.php`), plus `is_secret` flag and expiry on either. Public-chat rooms and AI conversations are separate tables.

### 2.4 Permission rules found
- Any active workspace member can DM any other active member. No block list, no DM-restriction setting, no per-workspace "who can DM" setting exists (grep: no block feature in app/ or migrations). `who_can_add_members` / `who_can_edit_info` are group-only room settings.
- Suspended users are NOT excluded from `createDm` (only `Deactivated` is, `:47`); a suspended user can be DM'd but cannot log in. Directory also lists them (only deactivated hidden, `WorkspaceController.php:77`). Spec FR-WS-005 (`:840`) says deactivated shown as "account closed" only if still in a room, but current directory hides them.
- Removed workspace member (`workspace_members.status=removed`): `createDm` -> 404. Their old group messages still show an avatar.
- Cross-workspace: user lookups are scoped by the `X-Workspace` context; the popup can only be reached for a sender in the current workspace's room.
- LATENT BUG (found, not part of the ask, but this feature makes it reachable): `dm_key` is hashed from the two user ids only, no workspace id, and is globally unique. Two people who share TWO workspaces can have a DM in only one of them. In the second workspace the existence check is workspace-scoped (`Room` has `WorkspaceScope`, `Models/Room.php:22`) so it finds nothing, the insert hits the unique key, and the catch block's `firstOrFail()` (`CreateRoomAction.php:70`) is also scoped -> `ModelNotFoundException` -> 404. Spec says "DM between the two in THIS ws" (`:856`). Needs a Tech Lead decision (fix = include workspace_id in the key + migration/backfill; `db_update` style note: this repo uses real migrations). Same shape for a soft-deleted DM (`deleted_at`): lookup ignores it (`:55`) but it still pins the unique key -> same 404. Verify before building; either is a pre-existing bug independent of the popup.

## 3. User stories
- US1 As a group member I click a colleague's avatar next to their message and see who they are (name, @username, photo larger, online or not).
- US2 From that popup I tap "Message" and land in our private 1-1 chat, whether it is new or already existed.
- US3 If I click my own avatar area / the bot / a closed account, I get a sensible state, not an error.
- US4 I can do all of this by keyboard and screen reader.

## 4. Acceptance criteria (proposed FR-PROF-009)
1. AC-1 In a GROUP room on web, the sender avatar beside another member's message is an interactive control (button, accessible name "View profile: {display_name}"). In DMs there is no sender avatar today and none is added. My own messages: no avatar, no change.
2. AC-2 Activating it (click, Enter, Space) opens a profile popup anchored to the avatar showing: large avatar (md; animated GIF respects reduced-motion as in `Visual.tsx`), display_name, @username, workspace role label only when admin/owner, presence (online/offline, no timestamp). Nothing else (see section 6).
3. AC-3 Popup has primary button "Message" (i18n th/en). Pressing it calls the existing `POST /rooms {type:'dm', user_id}` (non-secret), then navigates to `/rooms/{id}`, closes the popup.
4. AC-4 If the response is 200 (DM exists) the user lands in that existing room; if 201, the new room. No second DM is ever created (server dm_key dedupe, unchanged).
5. AC-5 While the request is in flight the button is disabled with a busy state; repeated clicks produce at most one POST.
6. AC-6 Failure shows an inline alert in the popup (role="alert"), keeps the popup open, button re-enabled. 404 -> "This person can't be messaged" copy (covers deactivated/removed).
7. AC-7 Popup data comes from the message `sender` object plus the cached room roster for presence/role (no new request on open). Missing roster entry (person left the room / not loaded) still shows name/username/avatar and omits presence/role.
8. AC-8 No Message button for: self (my own avatar is never rendered in the list; if reachable from another surface, show profile without the button), the AI bot (`__banana_ai_bot__`; avatar is not interactive at all), and senders whose DM attempt returns 404 (button replaced by "Account unavailable" after the failed attempt).
9. AC-9 Landing in a DM that I previously hid works (room opens); no extra un-hide step required. Sending a message un-hides it (existing behaviour).
10. AC-10 Closing: Esc, outside click, close button, or navigating away. Focus returns to the avatar that opened it. Popup is focus-trapped like the existing `<dialog>` pattern (`MessageItem.tsx:511`, `RenameGroupDialog.tsx:65`); tab order close -> Message.
11. AC-11 Layout: desktop = anchored popover next to the avatar, flips to stay inside the viewport; narrow screens (<=760px) = bottom sheet/centered dialog. (Depends on Q3 for whether the avatar is shown on narrow screens.)
12. AC-12 Realtime/safety: popup never shows data from a stale profile longer than the open session; display_name/avatar changes (`user.updated`) update the open popup if the roster refreshes; no PII added to logs.
13. AC-13 The existing directory row click (`MembersPage.tsx`) keeps working unchanged. Spec amended: FR-ROOM-001 gets a second entry point; FR-WS-005 row text unchanged.
14. AC-14 Tests: Playwright (desktop + 390px), unit test of dm-from-popup helper with 200/201/404/422/network error, a11y keyboard test, Feature test that a second POST returns 200 same room id (TC-ROOM-002 already covers; add concurrent-POST test if absent).

## 5. Out of scope (explicit)
- Mobile (Expo) UI: room screen has no avatars at all; mobile keeps directory-based DM. Follow-up ticket.
- Edit-your-own-profile from the popup; editing others; role changes, remove-from-group, mute, call buttons in the popup.
- Secret (expiring) DM option in the popup. Popup always opens/creates the normal DM.
- Adding title/department/email/phone/bio/status-text fields (no such data exists; FR-PROF-002 is P2).
- Making avatars clickable in read receipts, reactors, call tiles, mentions, member_added system lines, room list (follow-up; same component can be reused later).
- A room member panel/list (does not exist; separate feature).
- Block/mute-user, workspace "who can DM me" setting.
- Fixing the multi-workspace `dm_key` collision (tracked as a separate bug, section 2.4) unless TL decides it blocks.
- Public-chat visitor/agent surfaces and the AI Assistant view.

## 6. Privacy and permission rules
- Show only: avatar, display_name, @username, presence (online/offline), workspace role badge for owner/admin. All already visible to every workspace member via directory.
- Never show or fetch: email (none exists), last_seen_at exact time, locale/timezone, status (suspended/deactivated), is_system_admin, room mute/hidden/read state, membership in other workspaces/rooms.
- Button gating is a UX hint only; authorization stays server-side (`createDm` active-member + not-deactivated check, 404 no-leak).
- Public-chat guests: no user ULID reaches them and they see no staff popups; unchanged.
- Cross-workspace: popup only for senders returned by the current workspace's room; request carries the current workspace slug.

## 7. Edge cases
| Case | Expected |
|---|---|
| Self | No avatar on my messages; if reached elsewhere, no Message button (server would 422 ROOM_DM_SELF). |
| AI bot sender | Not interactive (match `username === '__banana_ai_bot__'`; TL to pick a flag instead, e.g. `is_bot` on sender payload, to avoid hard-coding). |
| Deactivated or removed sender (old messages) | Popup opens from message data; Message -> 404 -> inline "can't be messaged"; no room created. |
| Suspended sender | Server allows DM (cannot log in, so unread). Recommend block it too: treat like unavailable (needs 1-line server change; see Q4). |
| Existing DM | `POST` returns 200 with that room; navigate. |
| Existing DM hidden by me | Same; room opens. |
| Existing DM soft-deleted by admin (`deleted_at`) | Today: lookup skips it, insert collides on unique dm_key -> 404 (section 2.4). Should be a TL-visible defect; popup shows the generic failure alert. |
| Existing secret DM only | Ignored; popup always uses the normal-DM namespace, so normal DM is created. Expired secret DMs irrelevant. |
| Double click / concurrent from both people | Client busy-guard + server unique key + catch-and-return; both end in the same room. |
| Clicking another avatar while popup open | Switch popup to new person, focus follows. |
| Avatar missing or broken photo | Initials fallback (Avatar primitive), no layout shift. |
| Grouped consecutive messages (avatar hidden via `visibility`) | Hidden avatar must be removed from tab order (`inert`/tabIndex -1). |
| Phone-width browser | Avatar is currently `display:none`; see Q3. |
| Keyboard / SR | Button with name, `aria-haspopup="dialog"`, focus trap, Esc, focus restore, visible focus ring, role="alert" for errors, 44px target when shown on touch. |
| Long names | Truncate with title; no horizontal scroll at 320px. |
| Reduced motion | Animated GIF avatar paused per `usePrefersReducedMotion`. |

## 8. Open questions (with recommended answers)
Q1 (Decide) New endpoint for profile? RECOMMEND no. Use `sender` + cached roster; reuse `POST /rooms`. Optional later `GET /members/{id}` only if we need account-closed state up front.
Q2 (Decide) Anchored popover vs full dialog on desktop? RECOMMEND anchored popover with the same `<dialog>`/focus-trap rules; sheet below 760px.
Q3 (CUSTOMER) Should avatars appear on phone-width web? They are hidden today. RECOMMEND show a small (24-28px) avatar in groups at <=760px so the feature works on mobile web; confirm with customer since it changes the compact layout they may have approved.
Q4 (Decide) Suspended target? RECOMMEND treat as unavailable (exclude in `createDm`, popup hides button). Tiny server change + test.
Q5 (Decide) Click the sender name too? RECOMMEND yes: same handler, helps small screens; purely additive.
Q6 (Decide) Also make avatars clickable in read receipts/reactors/mentions? RECOMMEND no for this slice; build the popup as a reusable component for them next.
Q7 (Decide) Add a secret-DM option? RECOMMEND no (out of scope).
Q8 (CUSTOMER) Meaning of "chat room": we assumed group rooms (DMs have no sender avatar). Is a member list inside the room expected too? RECOMMEND confirm; a member panel is a bigger separate feature.
Q9 (CUSTOMER) Is mobile (Expo) app in scope for this request? RECOMMEND web first; mobile has no in-room avatars to click.
Q10 (Tech Lead) Multi-workspace `dm_key` collision and soft-deleted DM pinning the key (section 2.4): confirm and decide fix-in-slice vs separate.
