# Brief (PO): Share board ticket to chat + ticket links + link preview

Status: DRAFT for Tech Lead. Proposed IDs: FR-KAN-006 (share + card), FR-MSG-013 (link preview), DEC-100.. (next free DEC is 100).

## 1. Requirement (restated)
1. On /board, a button to share a ticket into a chat room; the chat renders a ticket card whose status follows the ticket in realtime.
2. A copyable ticket link, usable by workspace members; opening it lands on /board with that ticket open.
3. Any link sent in chat gets a preview; a ticket link renders as the same ticket card.
4. Public links (join-able without account) render as a card with a Join button.

## 2. Confirmed current state (verified in code)
- Board is ONE per workspace, no per-board membership. Every ACTIVE workspace member can read every ticket: `KanbanController::ticket()` is `KanbanTicket::where('workspace_id', ctx)->findOrFail` (apps/api/app/Http/Controllers/Api/V1/KanbanController.php:46-49); routes api.php:208-216 sit under `workspace.context` (X-Workspace-Id, non-member 403/404). Only lane edit is admin/owner (BoardService.php:37).
- Premise FIX for item 2: the deep link ALREADY exists. `/board/:ticketId` renders BoardPage (apps/web/src/App.tsx:106-108); BoardPage reads `useParams().ticketId` and fetches the detail (BoardPage.tsx:52,84-89); cards navigate to it (BoardPage.tsx:232,324). Missing: a visible "copy link" UI, and the link carries NO workspace, so it opens in the viewer's *current* workspace (session `currentWorkspace`, App.tsx:30). A multi-workspace user following a link would see a 404 unless we switch workspace.
- Tickets cannot be deleted or archived: no DELETE route; lanes with tickets cannot be deleted (BoardService.php:79). Tickets move between lanes, and lanes can be renamed or flagged `is_done`. "Status" = lane (name/colour/is_done).
- Realtime: `BoardChanged` (apps/api/app/Events/BoardChanged.php) broadcasts `board.changed` on the workspace channel with NO ticket content (EVT-064, FR-KAN-005, spec PRODUCT_SPEC.md:1259); channel auth = active workspace member (routes/channels.php:49). BoardPage listens, invalidates queries (BoardPage.tsx:100-110) and also polls 30s. So a chat card can reuse the same event and refetch with the viewer's own credentials, with no new payload and no leak.
- Messages: `MessageType` = text/image/video/file/system (Enums/MessageType.php). Existing structured-card precedent: system message `call_started` rendered as `CallStartedCard` (MessageItem.tsx:381, SystemMessageWriter.php:93, CallService.php:134). `messages.metadata` jsonb exists, written by `MessageWriter::write(..., $metadata)` (MessageWriter.php:49,113); the spec reserves it for "link preview (P2)" (PRODUCT_SPEC.md:403) but serializer exposes only `forward` (MessageSerializer.php:102-108). Forward (MessageForwarder) copies body/attachments into other rooms with RoomPolicy checks - a ticket-share message forwarded must behave sanely.
- Link preview does NOT exist: no unfurl code anywhere; spec lists it as P2/out of scope (PRODUCT_SPEC.md:1061, 3749). Message bodies render through `Markdown` which already makes http(s) links clickable (components/ai/Markdown.tsx:9-21, MessageItem.tsx:482).
- Public (no-login) links that exist:
  a. Public meeting `/meet/<64-hex code>` (MeetingsPage.tsx:106; routes `GET/POST /public-meetings/{code}`[/join], api.php:106-108). `GET` is unauthenticated and returns title, expires_at, capacity (MeetingController.php:70-76) and 410 when ended/expired - already a safe "lobby preview" source.
  b. Public chat visitor link `/support/<code>` (PublicChatService.php:116). The code IS the visitor's identity (bearer; PublicChatRoom.php comments, PublicChatVisitorController.php:31). Staff have no use for it; staff surface is `/public-chat/:roomId`.
  c. Workspace invite `/join/<token>` (WorkspaceInviteController.php:29; preview GET /join/{token} returns workspace name only, InviteRedemptionController.php:19). Single-use bearer.
- Customer's "public chat" most plausibly = a. meetings (and possibly b). Needs confirmation (Q3).

## 3. User stories
- US1 As a member I share a ticket into a room I belong to so colleagues see and open it in one tap.
- US2 As a room member I see the ticket's current lane/priority/assignee live without opening /board.
- US3 As a member I copy a ticket link, paste it anywhere in chat, and it becomes a card.
- US4 As a member I paste a meeting link and the room shows title, expiry and a Join button.
- US5 As a member who cannot see a ticket (other workspace), I get no ticket data from the card.

## 4. Acceptance criteria
Ticket share
- AC-1 Ticket detail on /board has "Share to chat": room picker (rooms where user is an active member and may post, same rules as forward targets), optional note. Result is a message in the room.
- AC-2 The message stores ONLY `{ticket_id, workspace_id}` (+ optional note as body). No title/lane/assignee snapshot is stored or serialized, so nothing goes stale and nothing leaks via message history, search, push or room-list preview. Push/preview text is generic (e.g. "Shared a ticket"; Thai copy by Tech Lead/UX).
- AC-3 The card is hydrated client-side per viewer from `GET /board/tickets/{id}` (existing, workspace-scoped). Shows `#number`, title, lane chip (name/colour, done style), priority, assignee, due. Click opens `/board/{id}`.
- AC-4 Realtime: any `board.changed` on the workspace channel makes visible cards refetch (debounce, batch per workspace, dedupe by ticket; one request per distinct ticket on screen, not per card). Lane move on /board updates the card in an open room within the realtime path (target under 2 s on healthy connection); 30 s poll/refocus recovers missed events like the board.
- AC-5 Card states: loading skeleton; not-found/forbidden -> neutral "Ticket unavailable" (no distinction between deleted and no-access); offline -> last hydrated data with stale marker.
- AC-6 Sharing a ticket does not grant anything: room members who are not active members of the ticket's workspace (not possible in a workspace room, but possible if rooms ever span workspaces) get "unavailable".
- AC-7 Sharing is rate-limited like normal sends; idempotent via client_message_id like other messages.
Ticket link
- AC-8 Ticket detail shows the link and a "Copy link" button. Format `{APP_URL}/board/{ticketId}` plus workspace hint `?ws={workspaceSlug}` (Q2). The link contains no secret and grants nothing beyond normal login + membership.
- AC-9 Following the link: unauthenticated -> login -> return to the same URL; authenticated member -> `/board/{id}` with the ticket drawer open; if `ws` differs from current workspace and the user is a member, switch workspace first (clearing drafts as FR-KAN-005 already requires); not a member / ticket missing -> board page with "Ticket not found" notice, no data.
Link preview
- AC-10 Ticket links: when a text message body contains a URL on this app's origin matching `/board/{ulid}`, render a ticket card under the message (same component as AC-3). Resolution is client-side only, from the URL; the server stores nothing extra (body stays the source of truth). Edited/removed link -> card disappears.
- AC-11 Meeting links (`/meet/{64hex}` on this origin): card with title, "expires {time}", capacity, and Join button (-> `/meet/{code}`), populated by existing `GET /public-meetings/{code}`. 410/404 -> card "Meeting ended" with disabled Join.
- AC-12 Other links (v1 decision, Q4): NO server-side fetching of third-party pages. They stay as clickable links with `rel="noopener noreferrer"`, opening in a new tab. No OG image/title scraping.
- AC-13 Max 1 card per message in v1 (first supported link wins; ticket card plus meeting card allowed together only if both present - Tech Lead may simplify to first-link-only).
- AC-14 The /support visitor link and /join invite token are NEVER carded or resolved (Q3) - rendered as plain text link or, better, the composer warns before sending.
Non-functional
- AC-15 No new unauthenticated endpoint; no new broadcast carrying ticket content; no change to EVT-064 payload.
- AC-16 Works on web; mobile app is out of scope unless it shares the web bundle (flag to Tech Lead).

## 5. Permission / security rules
- Visibility rule = the board's: active workspace member of the ticket's workspace. Therefore sharing into any room of that workspace leaks nothing a room member could not already read. Share never carries content; every viewer authorises against `/board/tickets/{id}` with own token and X-Workspace-Id.
- Card for a ticket in a different workspace than the viewer's current one: the client must pass the ticket's workspace id (from message metadata or `ws`), and the API's membership check decides. Never fall back to current workspace silently.
- DM/secret-chat rooms: allowed targets as for forward; secret-chat rooms refused (forward precedent: "secret-out refused" - Tech Lead check whether sharing INTO secret chats should be allowed; recommend allow in, because data stays hidden by AC-2).
- Preview SSRF: not applicable because v1 does no server-side fetch (AC-12). If the customer insists on third-party unfurl (Q4) it requires: server-side fetcher with scheme allow-list http/https, DNS resolution + block private/loopback/link-local/metadata IPs re-checked on each redirect (max 3), 5 s timeout, 1 MB cap, no cookies/auth, image proxying (never hotlink), per-workspace rate limit, off-by-default setting, no preview for URLs containing credentials or bearer-looking 64-hex paths. This is a separate DEC and security review.
- Bearer-link hygiene: pasting a `/meet/{code}` into a room hands that capability to every room member (and push/search index). That is the creator's choice, already true today for the plain URL. Cards must not log or push the code beyond what the body already contains. Never preview-by-fetch `/support/` or `/join/` (AC-14).

## 6. Edge cases
- Ticket deleted: impossible today (no delete). If added later -> AC-5 "unavailable".
- Ticket moved lane / lane renamed / lane marked done: live update through AC-4.
- Ticket archived: no such state; if introduced, treat as unavailable unless viewer-permitted.
- Viewer not in workspace / removed member / archived workspace (WS_ARCHIVED read-only): card unavailable; share button disabled.
- Same ticket shared many times: one refetch per ticket, many cards.
- Link to ticket in another workspace the viewer belongs to: switch (AC-9) or card with workspace label; recommended: card shows, click switches workspace.
- Forwarded ticket-share message: forward as the same card (still just ids); body note copied.
- Edited message: card follows body; deleted message: no card, no fetch.
- Realtime missed: 30 s poll + refocus. Many cards in a long scroll: only hydrate cards near viewport.
- Message search / room-list preview / push: show generic text only.
- Very old messages after ticket renumbering: number is per-board monotonic, safe.
- Meeting link expired/ended: AC-11. Meeting feature disabled by setting (`enabled()` in MeetingController): treat as plain link.

## 7. Out of scope (v1)
Third-party unfurl (OG scraping); image previews; editing ticket from the card (drag/move from chat); per-ticket subscriptions or notifications into rooms; posting ticket-change activity lines into the room; public-chat staff join card; /support and /join cards; mobile native; multi-workspace rooms; ticket deletion/archive; cross-workspace share picker.

## 8. Open questions (recommended answers)
Q1 Share target: any room the user can post in? Rec: yes, same as forward; plus recent rooms list.
Q2 Link shape: Rec `/board/{id}?ws={slug}`; reuse existing route, no new route.
Q3 Which "public links" does the customer mean? NEEDS CUSTOMER. Rec: /meet meeting links get Join card; do NOT card /support (visitor identity) or /join (single-use invite); public-chat for staff is `/public-chat/{roomId}`, an authenticated link - could be a normal member-only card later.
Q4 Preview for ordinary external sites (e.g. news)? NEEDS CUSTOMER. Rec: not in v1 (security cost, no spec); clickable link only. If wanted, separate DEC with SSRF controls above.
Q5 Should the card also show in the chat room list preview? Rec: generic "Ticket #n" text only if we can avoid title; simplest "Shared a ticket".
Q6 Does the card need comments count/description snippet? Rec: no; title, lane, priority, assignee, due only.
Q7 Who may share? Rec: any member (read access = share access).
