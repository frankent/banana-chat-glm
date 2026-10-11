# Tech Lead design: avatar click -> profile popover -> "Chat 1-1" (FROZEN)

Status: FROZEN for Senior Dev. Base main d2abbe4. Inputs: `docs/briefs/avatar-profile-dm-po.md`. IDs proposed: FR-PROF-009 (popup), FR-ROOM-001 amended (second entry point), DEC-101 (popup) + DEC-102 (dm_key per workspace), TC-WEB-PROFPOP-*, TC-CORE-PROFPOP-*, TC-ROOM-1xx.
All paths relative to repo root. Read-only analysis; nothing was executed against any write path.

---------------------------------------------------------------------------

## PHASE A - what the code really does

### A1. Avatar sites in a room (web)
| Site | Where | Verdict |
|---|---|---|
| Sender avatar, left of bubble | `apps/web/src/components/MessageItem.tsx:432` `{!mine && showSender && <Avatar className="bc-message-avatar"/>}`; `showSender` = `room.type !== 'dm'` (`ChatView.tsx:488`) | THE click target (group rooms only, never own messages) |
| Sender name | `MessageItem.tsx:435` `<p class="text-xs font-semibold">` | second click target (see B3) |
| Hide at phone width | `apps/web/src/index.css:278` `.bc-message-avatar{display:none}` inside the `@media(max-width:760px)` block that starts ~line 258; desktop size at `index.css:~305` (28x28) | must change |
| Grouped follow-up rows | `index.css` rule `.bc-message[data-grouped="true"] .bc-message-avatar{visibility:hidden}` (still focusable today if it were a button) | must be removed from tab order |
| Chat header avatar | `ChatView.tsx:383-384` (group photo editor button / DM peer) | not touched |
| Reactors rows | `MessageItem.tsx:~143` (`ReactorsDialog`) | out of scope |
| Read-receipt rows | `ReadReceipt.tsx:80` | out of scope |
| @mention list | `Composer.tsx:287` | out of scope (insert action) |
| Call tiles/ringing | `calls/CallTile.tsx:57`, `CallProvider.tsx:173` | out of scope |
| Typing | names only (`ChatView.tsx:~528`) | no avatar |
| System messages | text only (`MessageItem.tsx:44-58`) | no avatar |
| Rendered @mention | markdown `.bc-mention` span, no avatar | no avatar |

Confirmed: PO section 2.1 is right. There is exactly one avatar site and one name site.

### A2. How the web starts a DM today (reuse)
- `MembersPage.tsx:20-26`: `endpoints.createDm(member.id, slug)` -> `navigate('/rooms/' + result.room.id)`; a `busy` id state disables all rows; errors shown as plain `e.message`. No cache invalidation.
- Client: `packages/api-client/src/endpoints.ts:305` `createDm(userId, slug, secret?)` -> `POST /api/v1/rooms {type:'dm', user_id}` returns `RoomDetail`; status 200 (existing) / 201 (new) is NOT exposed to the caller (api.request returns body only). We do not need it.
- Server: `RoomController::store` -> `CreateRoomAction::createDm` (`apps/api/app/Domain/Room/Actions/CreateRoomAction.php:42-90`): self -> 422 `ROOM_DM_SELF`; target not active ws member or `users.status = deactivated` -> `abort(404)`; lookup `Room where dm_key (workspace-scoped) and deleted_at null`; insert; catch unique violation -> re-select.
- ApiError carries `.status` and `.code` (`packages/api-client/src/error.ts:13-25`); `NetworkError` also exported (used in `RenameGroupDialog.tsx:12-14`).
- Routes: `/rooms/:roomId` (`App.tsx:109`). Workspace is NOT in the URL; it comes from `useSession().currentWorkspace` (`state/session.ts:127 switchWorkspace`).

### A3. Primitives to reuse (there is NO Popover primitive)
- Modal pattern, the one to copy: native `<dialog>` + `showModal()` in `useEffect`, `onCancel` handles Escape, `createPortal(..., document.body)`, `aria-labelledby`, `aria-busy`, `lang`, close button with `aria-label`, `role="alert"` error `<p>`: `RenameGroupDialog.tsx:48-97`; message menu `MessageItem.tsx:~506-512` (backdrop click via bounding-rect test on `onClick`); focus return via a trigger ref (`photoReturn`/`peopleReturn` pattern in ChatView/MessageItem).
- Styling base: `apps/web/src/avatar.css` (`.bc-avatar-editor`, `.bc-ae-header`, `.bc-ae-button.is-primary/.is-secondary`, `.bc-ae-error`, `--ae-*` tokens; "portaled so #root button geometry does not apply, every control states its own box"). New popup CSS goes in a NEW file `apps/web/src/profile-popover.css` that reuses these classes and tokens.
- `<Avatar large>` + `usePrefersReducedMotion` live in `components/Visual.tsx` (GIF handled inside the primitive).
- i18n: two mechanisms. Global `t(key, locale)` from `packages/shared/i18n/{th,en}.json` through `useChatText()` (`lib/use-chat-text.ts`), and local text maps (`lib/rename-text.ts` etc.). We use the shared JSON (spec: shared i18n; both locales in one place, mobile can reuse).
- Test infra: web has no vitest (`apps/web` has only Playwright `e2e/ui`); platform-agnostic unit tests live in `packages/chat-core` (CLAUDE.md rule). Fixtures: `e2e/ui/fixtures.ts` (`installChatFixture`, `openChat`, group room `ui-design`, peer `ui-peer`, me `ui-me`).

### A4. Sender payload (what the popup can show with zero requests)
- `UserStub` (`packages/shared/src/types.ts:25-32`): `id, username, display_name, avatar_attachment_id, avatar?`. Produced by `MessageSerializer.php:43-52`. NO status, NO workspace role, NO bot flag.
- Roster `GET /rooms/{id}/members` (`RoomController::members` ~408-455): adds ROOM `role`, `joined_at`, `presence` ('online'|'offline'); no status filter (deactivated/bot rows are included if still a member), `limit` max 100, web asks `limit=100` once (`endpoints.ts:348`, typed only as `UserStub & {role}` - `presence` is untyped today). Cached as `['room-members', roomId, me.id, wsId]`, staleTime 60 s (`ChatView.tsx:118-123`).
- CONSEQUENCES that contradict PO text:
  1. "workspace role label for admin/owner": the roster role is the ROOM role (group owner/admin/member), not the workspace role; the workspace role is only in the directory (`GET /members`, paginated/searchable). We show the ROOM role only, never the workspace role. (Cheaper, and arguably what you want inside a group.)
  2. "deactivated sender not clickable": the sender payload carries no status, so an old message's deactivated author cannot be recognised at render time without leaking status (PO section 6 forbids showing it). Decision: such avatars stay clickable; the Message attempt returns 404 and the popup flips to "unavailable". The AI bot is the only statically known non-clickable sender.
  3. Roster is capped at 100 and first page only: "not in roster" must NOT be read as "left/removed". It only means presence/role are omitted.

### A5. DM detection in the room list
- `RoomListItem` (`types.ts:79-87`): `room.type === 'dm'`, `other_user: UserStub | null`, `room.is_secret?`. Query key `['rooms', slug, filter]`; `filter='all'` is the canonical one (`hooks/useRooms.ts:21`), hydrated from IndexedDB first.
- The list API excludes HIDDEN rooms (`RoomController.php:78-84` `whereNull('room_members.hidden_at')`), and a secret DM is a different thing (own dm_key namespace, DEC-056). So a local lookup is a SHORTCUT only: match `type==='dm' && !is_secret && other_user?.id === targetId`; miss or stale -> POST (which returns the real answer, including hidden DMs).

### A6. Workspace switching
- Switch = `session.switchWorkspace(slug)` replaces `currentWorkspace`; ChatView re-keys all queries on `currentWorkspace.workspace.id` and already resets all of its transient dialogs in one effect (`ChatView.tsx:69`, deps `[roomId, slug]`). The popup state must be added to that effect. An in-flight `createDm` must capture `slug` at click time and drop its result if `slug`/room changed (otherwise we navigate to a room id that is foreign to the new workspace -> 404 page).

### A7. VERIFICATION of the PO's "latent bug": dm_key ignores the workspace  -> CONFIRMED, real, user-visible
Evidence:
- `CreateRoomAction::dmKey` (`:204-212`): `sha256(sorted(userA,userB))` with optional `secret:` prefix. No workspace id. (Spec table `PRODUCT_SPEC.md:355` says the same, and the spec text at `:856` says the dedupe is "in THIS ws".)
- DB (checked read-only in `orgchat_test`): `rooms_dm_key_unique UNIQUE btree (dm_key)` - global, not (workspace_id, dm_key). Migration `2026_09_07_000004_create_rooms_table.php:18`. No later migration touches it.
- `Room` has `WorkspaceScope` (`Models/Room.php:22`, `Models/Scopes/WorkspaceScope.php` adds `where workspace_id = ctx`), so both the pre-check (`:65`) and the race-recovery `firstOrFail()` (`:79`) only see the CURRENT workspace.
- `ModelNotFoundException` is rendered as 404 `NOT_FOUND` (`bootstrap/app.php:95`).

Scenario: Ann and Bob are both active in workspaces W1 and W2.
1. In W1 Ann opens a DM with Bob: `POST /rooms` (X-Workspace W1) -> pre-check empty, insert `dm_key=K(Ann,Bob)` -> 201. Works.
2. In W2 Ann (or Bob) does the same: pre-check scoped to W2 -> none; insert -> Postgres `rooms_dm_key_unique` violation -> `UniqueConstraintViolationException`; catch runs `Room::where(dm_key=K)->firstOrFail()`, scoped to W2, the only row is in W1 -> `ModelNotFoundException` -> HTTP 404 `NOT_FOUND`. No W2 DM can ever exist; the client shows its "can't message" error. The exact same happens in the reverse order. Group rooms are unaffected (`dm_key` NULL, NULLs are distinct in the unique index).
3. Related, same shape: a soft-deleted DM (`deleted_at` set) still holds the key; lookup ignores it, insert collides, scoped re-select ignores it -> 404.

Relevance to THIS feature: YES for case 2. "Click avatar -> chat 1-1 / go to the existing room" is broken for every pair that shares more than one workspace and chats in the second one; the popup would show "this person can't be messaged" for a perfectly active colleague, which is a lie. Same bug already breaks MembersPage and NewRoomDialog today (so it is pre-existing), but we are about to put it in front of every message in every group. Verdict: IN SCOPE as a hard prerequisite slice (S1), kept minimal. Case 3 (soft-deleted pinned key) is OUT of scope (needs a product call on restore semantics; separate bug, listed under risks).

#### Minimal fix (S1)
Migration `apps/api/database/migrations/2026_10_10_000002_scope_dm_key_unique_to_workspace.php`:
- `Schema::table('rooms', fn ($t) => { $t->dropUnique('rooms_dm_key_unique'); $t->unique(['workspace_id', 'dm_key'], 'rooms_workspace_dm_key_unique'); });` (down() reverses it; reversal can fail if duplicates exist - document in the migration comment).
- NO data rewrite and NO key rehash: existing keys stay valid because every lookup is already workspace-scoped, so the same K may now legally appear once per workspace. This is why the fix is one index swap, not a backfill. (This repo uses real Laravel migrations for API; ignore the personal "db_update.sql" convention that applies to other projects.)
- Code: `CreateRoomAction.php` needs NO logic change for correctness (scope + new index make the pre-check, insert and catch consistent). Hardening only: in the catch block replace the scoped `firstOrFail()` by the same workspace-scoped query (unchanged), and add a defensive `where('workspace_id', $this->context->id())` explicitly so the intent survives a future scope refactor. Also update the docblock/`PRODUCT_SPEC.md:355` to `UNIQUE(workspace_id, dm_key)`.
- `ExpireSecretRooms::expireRoom` collision path is keyed by dm_key and runs with the room found by the scoped query; it keeps working (the expired row it finds is now always in the current workspace).
- Pest (S1): `TC-ROOM-100` same pair, two workspaces, DM in W1 then W2 -> two DIFFERENT room ids, both 201, each 200 on repeat; `TC-ROOM-101` race recovery still returns the existing room inside one workspace; `TC-ROOM-102` migration safe on a DB that already has one DM per pair (index swap). TC-ROOM-002 (dedupe 200) must stay green. Run per-file inside the container with `-e DB_DATABASE=orgchat_test -e CACHE_STORE=array -e QUEUE_CONNECTION=sync`, `php -d memory_limit=1G`.
- Deploy order: migration first (index swap is online-safe on Postgres, rooms table is small), then code. The code change is trivial, so there is no ordering hazard with the web slice; the web slice works without S1 except in the multi-workspace case.

#### Suspended target (PO Q4, pinned: "treated as unavailable")
One-line change in the same action: the active-target check becomes `users.status = Active` (instead of `!= Deactivated`), so suspended -> 404 like deactivated. Side effects: directory/new-room dialog now also 404 for suspended users (directory still lists them: acceptable, the click fails with the generic message; make `MembersPage` unchanged). An EXISTING DM with a now-suspended person is still reachable through the local-list shortcut and the room list, but `POST` would 404 - acceptable (popup shows "unavailable"). Pest `TC-ROOM-103` suspended target -> 404, no room row. Ship in S1 (API owner), flagged in risks as a (tiny) behaviour change to FR-ROOM-001.

---------------------------------------------------------------------------

## PHASE B - FROZEN DESIGN

### B1. Decisions (final)
1. Web only. No new endpoint. Popup data = `message.sender` (UserStub) + optional roster entry (presence, room role). No extra request on open, except an optional background roster refresh (below).
2. ONE popup instance, owned by `ChatView`, not per `MessageItem` (a long list would otherwise mount N dialogs). `MessageItem` only renders trigger buttons and calls `onOpenProfile(sender, triggerEl)`.
3. Implementation is a modal native `<dialog>` (gets focus trap, Escape via `cancel`, inert background, top-layer for free - same as every other overlay in the app), positioned by CSS: on viewports >760px it is a small card anchored next to the avatar (position computed once at open, clamped inside the viewport, flips above/below); on <=760px the same element becomes a bottom sheet. PO's "anchored popover" is satisfied visually; "click another avatar while open switches the popup" (PO edge row) is DROPPED because a modal dialog makes the page inert - outside click closes it, which is the existing app behaviour.
4. AI bot: not interactive. Detected by a shared constant `AI_BOT_USERNAME = '__banana_ai_bot__'` (new export in `packages/shared`), compared client-side; no API flag (YAGNI, avoids an API change; the username is reserved server-side by `GenerateRoomBotReply::bot()` and `CompactRoomContext`). Deviation risk noted below.
5. Self: own messages never render avatar/name triggers (`!mine`). The component still supports `isSelf` (hides the DM button, shows the "this is you" line) for future surfaces; unit/e2e covered through a prop, not through the UI.
6. No secret-DM option; the popup always calls the normal DM namespace.
7. Name click: YES (PO Q5). The button lives INSIDE the existing `<p class="text-xs font-semibold">` so the existing locator `.bc-message-bubble > p.font-semibold` (used in `e2e/ui/forward.spec.ts:22`) keeps matching and `toHaveText('มินตรา Chen')` still passes.
8. Phone width: show a 24px avatar in groups (see B4). Customer confirmation (PO Q3) is recorded as "assumed yes"; risk listed.

### B2. Files and exact contents

NEW `packages/chat-core/src/profile-popup.ts` (pure, vitest, exported from chat-core index)
```ts
export function isAiBotUsername(username: string | undefined): boolean
export function findExistingDmRoomId(rooms: readonly RoomListItem[] | undefined, userId: string): string | null
// type==='dm' && !room.is_secret && other_user?.id === userId; returns room.id of the first match (list is recency-sorted)
export type DmFailureKind = 'unavailable' | 'self' | 'forbidden' | 'network' | 'generic'
export function classifyDmError(error: unknown): DmFailureKind
// ApiError.status 404 -> unavailable; 422 && code 'ROOM_DM_SELF' -> self; 403 -> forbidden;
// NetworkError / TypeError -> network; anything else (incl. other 422, 429, 5xx) -> generic.
// Duck-typed on {status, code} + instanceof NetworkError (api-client import) - chat-core must not import web code.
```
(If chat-core cannot import api-client without a cycle, accept `{status?: number; code?: string; name?: string}` structurally and detect network by `name === 'NetworkError' || error instanceof TypeError`.)

EDIT `packages/shared/src/types.ts`: add `export const AI_BOT_USERNAME = '__banana_ai_bot__'` (or in `index.ts`) and `export interface RoomRosterMember extends UserStub { role: string; joined_at?: string | null; presence?: 'online' | 'offline' }`.
EDIT `packages/api-client/src/endpoints.ts:348`: return type `RoomRosterMember[]` (type-only; no behaviour change).

NEW `apps/web/src/components/ProfileAvatarButton.tsx`
```ts
props: { sender: UserStub; label: string /* "View profile: {name}" via t() */; hidden?: boolean /* grouped row */;
         onOpen: (sender: UserStub, trigger: HTMLButtonElement) => void; variant: 'avatar' | 'name' }
```
- renders a real `<button type="button" className="bc-profile-trigger" aria-haspopup="dialog" aria-label={label} data-testid="profile-avatar-button" | "profile-name-button">`; `variant='avatar'` wraps `<Avatar name avatar className="bc-message-avatar"/>`; `variant='name'` renders the display name text (the `<p>` stays the parent).
- `hidden` (grouped row): `tabIndex={-1}`, `aria-hidden="true"`, `disabled` not used (keep layout), and CSS keeps `visibility:hidden` which already removes it from AT/tab order; belt and braces.
- If `isAiBotUsername(sender.username)` render the plain `<Avatar>`/text with NO button (today's markup).
- No `aria-expanded` (modal dialog, not disclosure).

NEW `apps/web/src/components/ProfilePopover.tsx`
```ts
props: {
  user: UserStub;                      // from message.sender
  roster?: RoomRosterMember;           // optional; presence + room role only
  isSelf: boolean;
  returnFocusTo: HTMLElement | null;   // the trigger
  anchorRect: DOMRect | null;          // trigger.getBoundingClientRect() at open (null -> centered)
  slug: string;                        // workspace slug captured at open
  existingDmRoomId: string | null;     // from findExistingDmRoomId(rooms, user.id)
  onClose: () => void;
  onNavigate: (roomId: string) => void;// ChatView: navigate(`/rooms/${id}`)
}
```
- `<dialog ref className="bc-avatar-editor bc-profile-pop" data-testid="profile-popover" aria-labelledby={nameId} aria-describedby={metaId} (the id on the presence/role line; omitted when that line is absent) aria-busy={busy} lang={locale}>`, `showModal()` in `useEffect`, `onCancel` -> `preventDefault(); if (!busy) close()`, backdrop click (reuse the bounding-rect check in `MessageItem.tsx:~508`), `createPortal` to `document.body`. Escape and outside click are ignored while a request is in flight? NO: closing during busy is allowed (it only abandons navigation, see double-guard); only the DM button is disabled. Decision: Escape/outside always close; the in-flight result is dropped via a `cancelled` ref.
- Content: large `<Avatar large>` (md/GIF through the primitive), `<h2 id={nameId}>` display name (truncate + `title`), `@username` line, presence line (only when `roster?.presence` known: dot + "Online"/"Offline", `role="status"` not needed, static), room-role chip only for `owner`/`admin` ("Group owner"/"Group admin"), close button (top-right, `aria-label`, 44px target).
- Actions: primary `<button data-testid="profile-dm-button">` "Chat 1-1" (`autoFocus` on it; tab order: close -> Chat 1-1). Hidden when `isSelf` (instead a muted line "This is you") or after `unavailable`. While busy: `disabled`, `aria-disabled`, text "Opening…". Error `<p role="alert" data-testid="profile-dm-error">` below the button; button re-enabled on retryable errors (`network`, `generic`, `forbidden`), replaced by the static "unavailable" state on `unavailable`.
- DM action (`startDm`):
  1. `if (busyRef.current) return; busyRef.current = true` (ref, not state, so two synchronous clicks cannot both pass).
  2. If `existingDmRoomId` -> `onNavigate(existingDmRoomId); close()`; NO request.
  3. Else `await endpoints.createDm(user.id, slug)`; if the popup was closed (`cancelled`) or the session slug changed (`useSession.getState().currentWorkspace?.workspace.slug !== slug`) -> drop silently; else `invalidateQueries(['rooms', slug])`, `onNavigate(result.room.id)`, close.
  4. catch -> `classifyDmError`: `unavailable` -> state `unavailable` (button gone, text "Account unavailable"); `self` -> state `self`; `forbidden`/`network`/`generic` -> error key, button back; `finally busyRef=false; setBusy(false)` unless unmounted.
  5. POST returning 200 vs 201 is irrelevant: both navigate. A hidden-by-me DM returns 200 and opens (AC-9).
- Positioning: computed once in a `useLayoutEffect` after `showModal()`: set CSS vars `--pp-x/--pp-y` on the dialog (left = clamp(rect.right + 8, 8, vw - w - 8), if no room on the right use rect.left - w - 8; top = clamp(rect.top - 8, 8, vh - h - 8)). Recompute on `resize`; close on `scroll`? NO (the page is inert; only `resize`/orientationchange reposition).

EDIT `apps/web/src/components/MessageItem.tsx`
- New optional prop `onOpenProfile?: (sender: UserStub, trigger: HTMLButtonElement) => void`.
- line ~432: when `onOpenProfile` and `message.sender` exist, render `<ProfileAvatarButton variant="avatar" hidden={grouped} .../>` in place of the bare `<Avatar>`; otherwise unchanged. Line ~435: inside the `<p>`, `{onOpenProfile ? <ProfileAvatarButton variant="name" .../> : message.sender.display_name}`.
- Nothing else in this file changes.

EDIT `apps/web/src/components/ChatView.tsx`
- State `profile: { sender: UserStub; trigger: HTMLButtonElement; rect: DOMRect } | null`; handler passes `onOpenProfile` to `<MessageItem>` (line ~486).
- Add `setProfile(null)` to the reset effect at line 69 (deps `[roomId, slug]`).
- Render `{profile && <ProfilePopover .../>}` next to the other dialogs; `roster = membersQuery.data?.find(m => m.id === profile.sender.id)`; `existingDmRoomId = findExistingDmRoomId(queryClient.getQueryData(['rooms', slug, 'all']), profile.sender.id)`; `isSelf = profile.sender.id === me.id`.
- On open: if `Date.now() - membersQuery.dataUpdatedAt > 30_000` call `membersQuery.refetch()` (background; popup re-renders with fresh presence; no spinner, no blocking).

EDIT `apps/web/src/index.css` (the 760px block, line ~278): replace `.bc-message-avatar{display:none}` by `.bc-message-avatar{width:24px;height:24px;font-size:9px;margin-top:2px}` and give `.bc-message-bubble` `max-width:calc(100% - 38px)` for rows that have an avatar (`.bc-message-list` `max-width:86%` currently; verified safe at 320px: (320-20)=300 container, avatar 24 + gap 8 = 32, bubble limit min(86%, 268) -> no overflow). Grouped rows keep `visibility:hidden` so the column stays aligned.
NEW `apps/web/src/profile-popover.css` (imported in `ProfilePopover.tsx` like `avatar.css`): `.bc-profile-trigger{display:inline-flex;padding:0;border:0;background:none;border-radius:50%;cursor:pointer;position:relative}` with `::after{content:"";position:absolute;inset:-10px}` (44px touch area without layout shift), `:focus-visible{outline:2px solid var(--ae-focus,#376fb0);outline-offset:2px}`; the name variant `border-radius:4px; font:inherit; text-align:left; text-decoration:underline on hover/focus`; `.bc-profile-pop` width `min(300px, calc(100vw - 16px))`, `position:fixed; left:var(--pp-x); top:var(--pp-y); margin:0` at `min-width:761px`; at `max-width:760px`: `position:fixed; inset:auto 0 0 0; width:100%; max-width:none; border-radius:18px 18px 0 0; padding-bottom:calc(20px + env(safe-area-inset-bottom)); animation slide-up`. Honour `prefers-reduced-motion` (animation none). CSS rules (frozen): write overrides as `.bc-avatar-editor.bc-profile-pop` (higher specificity, load-order independent) and import `avatar.css` before `profile-popover.css` in `ProfilePopover.tsx`. At `min-width:761px`: `inset:auto` FIRST, then `left/top` from `--pp-x/--pp-y` (defeats the UA `:modal` inset), and `.bc-avatar-editor.bc-profile-pop::backdrop{background:transparent;backdrop-filter:none}` so it reads as an anchored popover; at `max-width:760px` keep the dimmed backdrop for the sheet. Contrast: reuse `--ae-*` tokens (already AA), muted text `--ae-muted`.

EDIT `packages/shared/i18n/th.json` and `en.json` (S0, before the web slice). Keys:
| key | th | en |
|---|---|---|
| profile.open | ดูโปรไฟล์: {name} | View profile: {name} |
| profile.close | ปิด | Close |
| profile.dm | แชท 1-1 | Chat 1-1 |
| profile.dmOpening | กำลังเปิดแชท… | Opening… |
| profile.online | ออนไลน์ | Online |
| profile.offline | ออฟไลน์ | Offline |
| profile.roleOwner | เจ้าของกลุ่ม | Group owner |
| profile.roleAdmin | ผู้ดูแลกลุ่ม | Group admin |
| profile.self | นี่คือคุณ | This is you |
| profile.unavailable | ไม่สามารถแชทกับบัญชีนี้ได้ | This person can't be messaged |
| profile.errForbidden | คุณไม่มีสิทธิ์แชทกับคนนี้ในพื้นที่ทำงานนี้ | You don't have permission to message this person in this workspace. |
| profile.errNetwork | เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง | Could not connect. Check your internet and try again. |
| profile.errGeneric | เปิดแชทไม่สำเร็จ กรุณาลองอีกครั้ง | Could not open the chat. Please try again. |
(`{name}` substitution done by caller `.replace('{name}', ...)`, same as `message.forwardedFrom`.) A vitest parity check: every `profile.*` key exists in both files.

### B3. Accessibility contract
- Real `<button>`; accessible name "View profile: {display_name}"; `aria-haspopup="dialog"`.
- Dialog: `aria-labelledby` name heading; `aria-busy` while sending; error uses `role="alert"`; "unavailable"/"self" lines are plain text in the dialog (announced when dialog opens or via the same `role="alert"` when produced by an action).
- Focus: on open focus the DM button (or the close button when no DM button); trap via modal dialog; Escape closes; focus returns to the trigger on close (`returnFocusTo.focus()` if still `isConnected`, otherwise focus the message list `ref`).
- Keyboard: Enter/Space on trigger (native), Tab order close -> Chat 1-1, Escape.
- Reduced motion: GIF paused by `Avatar`; sheet/pop animation disabled.
- Targets: >= 44px effective via `::after` on touch widths; visible focus ring.

### B4. <=760px layout (RECOMMENDED & SPECIFIED)
Show a 24px avatar in group rooms (DM rooms still render none). The sender name is also a trigger, so users who find the avatar too small have a second target. The popup is a bottom sheet (full width, safe-area padding, close button + Chat 1-1 stacked, 44px height each). No other compact-layout change. This changes the approved compact layout slightly (customer confirmation recommended, but low risk: 32px of width).

### B5. Failure & edge matrix
| Case | Behaviour | Test |
|---|---|---|
| Existing non-secret DM in local list | navigate, no POST | TC-WEB-PROFPOP-004 |
| Existing DM hidden by me (not in list) | POST -> 200 -> navigate | TC-WEB-PROFPOP-005 |
| No DM | POST -> 201 -> navigate; `['rooms',slug]` invalidated | TC-WEB-PROFPOP-006 |
| Local list holds only a SECRET DM with that person | ignored, POST normal | TC-CORE-PROFPOP-002 |
| 404 | "unavailable", button removed | TC-WEB-PROFPOP-007 |
| 403 | forbidden message, button re-enabled | TC-WEB-PROFPOP-008 |
| network error | network message, retry works | TC-WEB-PROFPOP-009 |
| 422 ROOM_DM_SELF | "this is you" | TC-CORE-PROFPOP-003 |
| 429/500/other 422 | generic, retry | TC-CORE-PROFPOP-003 |
| double click / Enter+click | exactly one POST | TC-WEB-PROFPOP-010 |
| Close while in flight | no navigation afterwards | TC-WEB-PROFPOP-011 |
| Workspace switch / room change while open or in flight | popup closed / result dropped | TC-WEB-PROFPOP-012 |
| AI bot message | no button, no popup | TC-WEB-PROFPOP-013 |
| Sender null (deleted user stub) | no avatar button (render as today) | TC-WEB-PROFPOP-013 |
| Grouped row | trigger not focusable; only the first row of a run is | TC-WEB-PROFPOP-014 |
| Roster entry missing | name/@username/avatar only, no presence/role | TC-WEB-PROFPOP-003 |
| Avatar broken | initials remain (Avatar primitive) | existing |
| 320px viewport | sheet fits, no horizontal scroll, bubble not clipped | TC-WEB-PROFPOP-015 |
| DM room type / own message | no trigger | TC-WEB-PROFPOP-002 |
| Two workspaces, same pair | second DM created (needs S1) | TC-ROOM-100 |
| Suspended target | 404 -> unavailable | TC-ROOM-103 |

### B6. Test plan
Vitest (`packages/chat-core/src/profile-popup.test.ts`): TC-CORE-PROFPOP-001 `findExistingDmRoomId` (dm match / group ignored / other_user null / undefined list); -002 secret DM skipped; -003 `classifyDmError` table (404, 422+ROOM_DM_SELF, other 422, 403, NetworkError, TypeError, 429, 500, unknown); -004 `isAiBotUsername`. Shared i18n parity test `profile.*` th/en (TC-CORE-PROFPOP-005).
Pest (S1, only API change): TC-ROOM-100..103 above (+ keep TC-ROOM-001/002/003/070 green; run `tests/Feature/Room/RoomTest.php` and `SecretRoomTest.php` per file).
Playwright `apps/web/e2e/ui/profile-popover.spec.ts` (fixtures: extend `installChatFixture` with a `profilePopup` option that routes `POST /api/v1/rooms`, `GET /rooms/:id/members` incl. `presence`; run for widths 390 and 1440 like `forward.spec.ts`):
- TC-WEB-PROFPOP-001 avatar is a button named "ดูโปรไฟล์: มินตรา Chen", opens dialog, shows name/@username.
- -002 no trigger in DM room or on own messages.
- -003 presence/role present with roster, absent without.
- -004..-014 per matrix (mock `POST /rooms`: assert request count; 200 vs 201; 404/403/offline).
- -016 keyboard: Enter opens, Tab order close->button, Escape closes, focus returns to the same avatar; outside click closes.
- -015 390/320 width: avatar visible at 24px, sheet anchored bottom, `document.documentElement.scrollWidth === innerWidth`.
- -017 GIF avatar paused under `reducedMotion: 'reduce'`.
- Existing specs that must stay green: `forward.spec.ts` (name locator), `chat-ui.spec.ts`, `bubble-visual.spec.ts` (avatar/bubble geometry at 390 may shift by the 24px avatar: QA to update ONLY expected geometry that intentionally changed and say so).
Block writes in Playwright by origin and use one route handler (project lesson), never against a real Api that creates DMs.

### B7. Slices and file ownership (disjoint)
| Slice | Owner scope | Files (exclusive) | Depends |
|---|---|---|---|
| S0 shared/spec | Senior Dev A | `packages/shared/i18n/th.json`, `en.json`, `packages/shared/src/types.ts` (+index export), `packages/api-client/src/endpoints.ts:348` type, `packages/chat-core/src/profile-popup.ts` (+index export, +test), `PRODUCT_SPEC.md` (FR-PROF-009 in profile section, FR-ROOM-001 second entry point, `:355` index text, DEC-101/DEC-102 in §15, Changelog row in §16, TC rows) | first, blocks S1/S2 only for compile |
| S1 API fix | Senior Dev B (parallel to S2) | `apps/api/database/migrations/2026_10_10_000002_scope_dm_key_unique_to_workspace.php`, `apps/api/app/Domain/Room/Actions/CreateRoomAction.php`, `apps/api/tests/Feature/Room/RoomTest.php` (or new `DmWorkspaceScopeTest.php`) | S0 not required |
| S2 web | Senior Dev C (parallel to S1, after S0) | `apps/web/src/components/ProfileAvatarButton.tsx`, `ProfilePopover.tsx`, `MessageItem.tsx`, `ChatView.tsx`, `apps/web/src/profile-popover.css`, `apps/web/src/index.css` | S0 |
| S3 QA | QA + automated QA (after S1+S2 merge) | `apps/web/e2e/ui/profile-popover.spec.ts`, `apps/web/e2e/ui/fixtures.ts` (additive option only), expected-geometry adjustments in `bubble-visual.spec.ts` if required | S1,S2 |
Rule for reviewers/QA: working tree is read-only, no stash.

### B8. Deviation risks (read these)
1. dm_key is a confirmed bug and now IN SCOPE (S1). Without it the feature lies ("can't be messaged") for pairs sharing 2+ workspaces.
2. Suspended exclusion changes `createDm` for ALL callers (directory, new-room dialog). Small but a spec-visible FR-ROOM-001 change -> needs the DEC and the TC.
3. Deactivated senders are clickable (status not in sender payload); the first click ends in "unavailable". This contradicts the parent's pinned phrasing "deactivated NOT clickable" but MATCHES PO AC-8 (button replaced by "Account unavailable" after a failed attempt); the alternative (add a status/`is_unavailable` flag to every message payload) changes the wire and leaks status. Frozen as: clickable, graceful 404.
4. Workspace-role badge in the PO brief is replaced by ROOM-role chip (data source is the roster).
5. Bot detection by reserved username constant, not a server flag; if the bot username ever changes both must change (constant lives in `packages/shared`, one place for web+mobile).
6. Modal dialog replaces "switch popup on clicking another avatar" and a truly non-modal popover.
7. 24px avatar at <=760px alters the compact layout the customer may have approved (`bubble-visual.spec.ts` geometry may need a deliberate update); also the `display:none` was possibly intentional to save width.
8. Local-list shortcut can be stale (room deleted/left): navigating to it yields the normal ChatView not-found/forbidden path; acceptable, same as clicking a stale room-list row. Presence from a 60 s-stale roster is refreshed in the background if older than 30 s; it can still be up to one poll behind.
9. Soft-deleted DM still pins the (now per-workspace) key -> 404; NOT fixed here (restore-vs-recreate needs a product decision).
10. `POST /rooms` 200 vs 201 is not needed by this feature (both navigate); do not add status plumbing to api-client.
11. Reverb `RoomCreated` is `toOthers()`: the creator's own room list is refreshed only through our `invalidateQueries(['rooms', slug])`; omitting it leaves the new DM missing from the sidebar until the next poll.
12. Mobile (Expo) untouched; `profile.*` keys are added to shared i18n so a later mobile slice can reuse them.
