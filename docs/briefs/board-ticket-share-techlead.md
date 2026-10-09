# Tech Lead design: share board ticket to chat, ticket links, link cards, external link preview

Status: FROZEN contract v2 (customer answers folded in: external previews ARE in; /support never carded).
Inputs: docs/briefs/board-ticket-share-po.md + coordinator update. Read-only analysis; no source changed.
New IDs: FR-KAN-007 (share + ticket link + deep link), FR-MSG-013 (link cards: ticket, meeting, external), DEC-100, API-240, API-241, TC-* in section 9.
**FR-KAN-006 is ALREADY TAKEN (ticket image attachments, PRODUCT_SPEC.md:1260) - the PO brief's proposed id collides. Use FR-KAN-007.** Latest ids today: DEC-099, API-239, EVT-089, TC-MSG-083, TC-KAN-015, TC-CORE-068, TC-WEB-080 (forward), FR-MSG-012.

---------------------------------------------------------------------------
## PHASE A - map of the real code (file:line)

### A1 Messages: create / validate / serialize
- Route `POST /rooms/{room}/messages` -> `MessageController::store` (apps/api/routes/api.php:288; MessageController.php:~150). Validation inline: `client_message_id` uuid required, `body` nullable string, `reply_to_message_id`, `attachment_ids` (only those keys). No `type`/`metadata` input from clients.
- `MessageWriter::write(...)` (apps/api/app/Domain/Message/MessageWriter.php:49): trims body, `message.max_length`, room row lock, idempotency on (room, sender, client_message_id), `deriveType` (text/image/video/file only), insert, mention sync, `NotifyMessage` push for non-system. `metadata` is server-only (written by AI share AiController.php:624, forward, bot_notice).
- `MessageType` enum = text/image/video/file/system (apps/api/app/Enums/MessageType.php).
- `MessageSerializer::toArray` (MessageSerializer.php:~62-95) exposes `type, body, system_event, forwarded_from, attachments, mentions, reactions`. `metadata` is NOT exposed except the `forward` slice (MessageSerializer.php:102-108, DEC-083).
- Room-list preview of a text row = first 120 chars of the body (RoomController.php:~697, `previewText` :722; system rows via `SystemMessageWriter::preview` SystemMessageWriter.php:~90).
- Edit: `MessageEditor` refuses system/deleted/forwarded rows (MessageEditor.php:153); body edit re-renders client-side, so a body-derived card follows the edit for free.
- Types shared: `Message` in packages/shared/src/types.ts; send in packages/api-client/src/endpoints.ts:360 `sendMessage`.

### A2 call_started precedent (system message + card)
- Write: `CallService::start` -> `SystemMessageWriter::write($room, $user, 'call_started', ['call_id','kind'])` (CallService.php:134) -> row `type=system, body=null, system_event={event,call_id,kind}`; fan-out after commit (SystemMessageWriter.php:~68, DEC-091). Preview text in `SystemMessageWriter::preview`.
- Render: MessageItem.tsx:381 `type==='system' && system_event.event==='call_started'` -> `components/calls/CallStartedCard.tsx`; card stores ids only, live state from `useCalls()` (CallProvider) - the same "ids in the row, state fetched live" idea we want here.
- Test pattern: apps/api/tests/Feature/Call/CallTest.php; web e2e apps/web/e2e/ui/call-message.spec.ts (mocks API with `page.route`, `installChatFixture`, `message(seq)` helpers from e2e/ui/fixtures.ts).
- Mobile: renders system rows with a fallback label; apps/mobile/app/room/[id].tsx:317 only special-cases `forwarded_from`. Mobile uses the shared Markdown parser (apps/mobile/src/ai/Markdown.tsx) so URLs in bodies are just links.

### A3 Body link parsing / rendering (web)
- `parseInline` (packages/chat-core/src/markdown.ts:170-204): bare `https?://...` and `[text](url)` become `{type:'link'}` nodes, http(s) only (`safeHref` :39), trailing `.,!;:` stripped.
- Web `Markdown` component (apps/web/src/components/ai/Markdown.tsx:9-21): `<a target=_blank rel="noopener noreferrer">`. Used by MessageItem.tsx:482 AND by AI chat and tickets. Therefore cards MUST NOT be added inside `Markdown`; they go in MessageItem under the body.
- The public visitor page (/support) and the agent page have their own renderers outside MessageItem; cards never appear there (this also guarantees the visitor can never trigger ticket hydration).

### A4 Board
- API: routes api.php:208-216 under `auth:api, account.active, password.fresh, workspace.context`; `X-Workspace-Id` carries the workspace SLUG (packages/api-client/src/client.ts:75-76 `workspaceSlug`). Scope: `KanbanController::ticket()` = `where workspace_id = ctx` + `findOrFail` (KanbanController.php:46-49). `show` (:60-76) returns ticket + 50 comments + 100 history rows (heavy) and carries `lane_id` only (no lane name/colour). `GET /board` (lanes) calls `initialize()` which can WRITE (default lanes) - not a good thing for passive card hydration.
- Non-member of the target workspace: `WorkspaceContextMiddleware` -> 403 `WS_FORBIDDEN`; archived -> 403 `WS_ARCHIVED` (reads still ok? read-only archive; sends refused).
- Realtime: `BoardChanged` (apps/api/app/Events/BoardChanged.php) event `board.changed`, no payload content; `RealtimeEvent::broadcastOn` converts to a PrivateChannel (so the channel is `private-workspace.{wid}`), auth = active member (routes/channels.php:49). Listener ONLY exists inside `BoardPage` (BoardPage.tsx:100-110: `echo.private('workspace.'+wid).listen('.board.changed', ...)` -> `invalidateQueries(['kanban', wid])`); also polls 30s.
- Query keys: `['kanban', wid, me.id, 'lanes'|'tickets'|'ticket', id]` (BoardPage.tsx:~66-90).
- Web page: `BoardPage` (BoardPage.tsx:30-40) renders `Board` keyed by `currentWorkspace.workspace.id`; routes `/board` and `/board/:ticketId` both -> BoardPage (App.tsx:~106-108). Drawer = `TicketDetails` (BoardPage.tsx:731-800, header block with `ticketKey(slug, number)`, lane name, priority, "Edit ticket").
- All board UI strings are hard-coded English (no i18n keys exist for board). Chat uses `useChatText()` + packages/shared/i18n/{th,en}.json (`chat.callEnded` en.json:197).

### A5 Workspace switching on deep link
- `session.switchWorkspace(slug)` (apps/web/src/state/session.ts:127-131) sets `currentWorkspace` from `workspaces` and persists LAST_WS_KEY. `Board` remounts on workspace id change -> drafts cleared (FR-KAN-005 satisfied by the existing `key=`).
- **GAP found:** a logged-out visitor of `/board/:id` is bounced by AppShell (AppShell.tsx:110-111) to `/login` with `state.from`, but `LoginPage` ignores `state.from` and only honours `?returnTo=` for `/meet/<64hex>` (LoginPage.tsx:26 + chat-core `meetingReturnPath`, meeting.ts:6). After login the user lands on `/`, so AC-9 ("login -> return to the same URL") is NOT met today. Must be fixed.
- No code reads a `?ws=` param anywhere today.

### A6 Room picker for "share to room"
- `ForwardDialog.tsx` (apps/web/src/components/ForwardDialog.tsx): `useRooms(slug)` + search + multi-select, bound to a `Message`. Its list is from `GET /rooms` (rooms the user belongs to). Hidden/expired secret rooms handled by `filterExpiredRooms` in useRooms. Reuse the interaction pattern but NOT the component (it is message/forward-API specific). Send path for the share = plain `endpoints.sendMessage` per target (below).

### A7 Public meeting lobby
- `GET /api/v1/public-meetings/{code}` (api.php:106; code regex 64 hex; `throttle:120,1`), MeetingController::show (MeetingController.php:70-76): unauthenticated (optional bearer only adds `identity`), returns `{title, expires_at, capacity, identity}`, `Cache-Control: no-store`. 410 when ended/expired (`find()` :36-43), 404 unknown, 503 when the calls feature is not configured (`enabled()` :20). Client: `endpoints.meetingLobby(code)` (endpoints.ts:155) typed `MeetingLobby` (shared types.ts:568). It does NOT report current participant count, so "full" cannot be shown on the card; the lobby handles that on Join.
- `/meet/:code` is outside EchoProvider/CallProvider (App.tsx:~72). Opening it in the same tab would abandon an active call in the SPA, so Join opens a NEW TAB (`_blank`, `noopener`). MeetingsPage builds the same path (MeetingsPage.tsx:106).

### A8 SSRF precedent (do not reuse)
- Only outbound-URL guard in the repo: `OpenAiCompatibleProvider` host check (OpenAiCompatibleProvider.php:~295-320): IPv4-only `gethostbyname`, FAILS OPEN when resolution fails, no redirect handling, no IP pinning, no IPv6. Unsuitable for user-supplied URLs. Build a dedicated fetcher.
- Rate limiters live in AppServiceProvider.php:82-89 (`message-forward`, `message-react`), settings defaults in `SettingsService` (:23), jobs run on Redis queues (QUEUE_CONNECTION=redis, CACHE_STORE=redis in .env.example), media disk + signed URLs via `AttachmentSerializer` (`mediaUrls->temporaryGetUrl`, 1 h, forced disposition, DEC-072).

### A9 Tests: patterns and numbering
- API Pest: apps/api/tests/Feature/{Kanban,Message,Meeting,Call,...}; Kanban setup in tests/Feature/Kanban/KanbanTest.php (helpers `loginAs`, `wsHeaders`, two workspaces `board-test` / `other-board`). SQLite cannot reveal PG schema errors (memory note): the new table must be proven on PG-compatible SQL by reading the migration, and no raw column names that differ.
- chat-core: Vitest next to source (`packages/chat-core/src/*.test.ts`, e.g. kanban.test.ts, meeting.test.ts, TC-CORE-xxx titles). api-client: packages/api-client/test/client.test.ts. shared: packages/shared/test/shared.test.ts.
- Web: no vitest/RTL in apps/web; coverage is Playwright UI suite `apps/web/e2e/ui/*.spec.ts` (config playwright.ui.config.ts, fixtures.ts, API mocked via `page.route`, run `node node_modules/@playwright/test/cli.js test --config playwright.ui.config.ts`). Test names embed the id: `test('TC-WEB-078: ...')`.
- Numbering: spec table rows `| TC-xxx | text | Layer |`; feature-prefixed ids exist for new work (TC-WEB-REACT-001, TC-WEB-ADDMEM-001). Follow that.

---------------------------------------------------------------------------
## PHASE B - frozen design

### B1 DECISION: message shape = ordinary text message containing the URL (NO new message kind)
Chosen: **body-embedded link, client upgrades to a card.** Share = `POST /rooms/{id}/messages` with `body = [note\n]<ticket URL>`. Zero change to message API/model/serializer/events/push/search/forward/edit/mobile.

Reasons
1. Satisfies asks 1, 3 (and 2) with ONE mechanism: pasted link and "Share" button produce identical rows.
2. A structured kind needs: enum + deriveType + validation + serializer + chat-core `Message` type + mobile + room-list preview + push text + search + forward + edit rules + bot context (RoomContextBuilder) + `NotifyMessage`. Every one of those is a crash/regression surface for apps/mobile, which "must not crash on unknown kinds"; with body-embedding mobile shows a clickable URL and nothing can break.
3. Privacy equals the PO's AC-2: the row carries `{slug, ticket ulid}` inside a URL, no ticket content. Push/search/room-list therefore show the URL (not title). Acceptable; the web room list prettifies it (B5.8).
4. Forward, edit, delete, secret chat, AI context all keep working unchanged; deleting/editing the message removes the card.
Trade-offs (accepted, listed as risks): (a) card recognition depends on the origin of the URL (see R1); (b) the raw URL text stays visible under/above the card; the card replaces the link line when the body is ONLY the URL (B5.3); (c) mobile native has no card (out of scope per PO AC-16).

### B2 URL grammar (frozen; implemented once in chat-core `link-cards.ts`)
Ticket URL: `{ORIGIN}/board/{ULID}` optionally `?ws={slug}` (no other params, no fragment significance). ULID = `[0-7][0-9A-HJKMNP-TV-Z]{25}` case-insensitive. `ws` = `[a-z0-9][a-z0-9-]{0,62}`. Share/Copy always emits `?ws=` with the CURRENT workspace slug.
Meeting URL: `{ORIGIN}/meet/{64 lowercase hex}` (same regex as `meetingReturnPath`).
`ORIGIN` match: `new URL(href).origin === window.location.origin` OR in `VITE_APP_ORIGINS` (comma list, optional). Origin is injected into the pure function (`classifyLink(href, appOrigins[])`) so chat-core stays platform agnostic.
Never carded and never fetched: any URL on an app origin whose path is not ticket/meeting (this covers `/support/*` and `/join/*`, B4).
Classification result: `{kind:'ticket', ticketId, ws|null} | {kind:'meeting', code} | {kind:'external', url} | {kind:'internal-plain'} | null`.
`extractLinkCards(body, appOrigins, max=1)`: runs `parseInline` over each line (skipping fenced code), takes link nodes in order, first node whose kind != 'internal-plain' wins (ONE card per message; supersedes PO AC-13). Priority is simply first-in-body.

### B3 API changes (only two read endpoints; no message API change)
Both: `auth:api, account.active, password.fresh, workspace.context`, GET, no state change, `Cache-Control: no-store` for B3.1.

**API-240 `GET /api/v1/board/tickets/{id}/card`** (route next to api.php:213; `->whereUlid('id')`; controller `KanbanController::card`)
- Rationale (contradicts PO "reuse existing show"): `show` ships 50 comments + 100 history + description + attachments per card and has no lane name/colour; a room with 20 ticket cards would issue 20 heavy requests plus a lane request, and `GET /board` initialises (writes). A slim endpoint is read-only and bounded.
- Authorization: exactly `ticket()` scoping: `KanbanTicket::where('workspace_id', ctx)->findOrFail($id)` -> 404 `NOT_FOUND` (use the generic Laravel 404; same shape as show). Workspace membership/archived handled by middleware (403 `WS_FORBIDDEN`/`WS_ARCHIVED` is NOT raised for GET on archived? follow what `show` does today - dev must verify by test, TC-KAN-018). Workspace comes ONLY from `X-Workspace-Id`; never from the ticket.
- 200 `{data: {id, workspace_id, number, title, type, priority, due_at, version, updated_at, assignee: {id, display_name}|null, lane: {id, name, color, is_done}}}`. Explicitly NO description, comments, history, attachments, labels, reporter.
- Throttle `throttle:board-card` = 240/min per user (new limiter in AppServiceProvider next to :82).

**API-241 `GET /api/v1/link-preview?url=<absolute http(s) URL, max 2048>`** (controller `LinkPreviewController::show`, throttle `link-preview` 60/min/user, plus uncached-fetch budget 20/min/user and 300/min/workspace via `RateLimiter::attempt` before dispatch)
- Validation: `url` required|string|max:2048|url; parse; scheme http/https; no userinfo; host not empty; port null/80/443 only. 422 `LINK_PREVIEW_INVALID` otherwise.
- **Internal exclusion (hard):** 422 `LINK_PREVIEW_INVALID` (reason `internal`) when the host equals any of: configured `APP_URL` host, `app.web_origins` setting hosts, `request()->getHost()`, or the URL would be classed ticket/meeting/internal by the same grammar. This protects ticket/meeting (they stay on internal cards) and /support, /join (bearer tokens).
- Behaviour: normalise URL (lowercase scheme+host, IDNA ascii, strip fragment, drop default port) -> `url_hash = sha256`. Lookup in `link_previews`:
  - fresh row `ready` -> 200 `{data:{status:'ready', url, title, description, site_name, image_url|null, image_expires_at|null, fetched_at}}` (image_url is a fresh signed URL to OUR copy).
  - fresh row `none` (negative cache) -> 200 `{data:{status:'none', url}}`.
  - no/stale row -> acquire `Cache::lock('lp:'.hash, 30)`; if got it, create row `pending`, dispatch `FetchLinkPreview` on queue `previews` (own worker, own egress policy), 202 `{data:{status:'pending', url}}`; if lock not obtained -> 202 pending. Client polls (B5.6).
- NEVER an error for upstream problems: blocked IP, DNS fail, timeout, 4xx/5xx, non-HTML, oversize, parse failure all store `none` (uniform; so the endpoint is not an internal-network oracle and error text never leaks resolver detail).
- Setting `link_preview.enabled` (default true; SettingsService key) - when false, endpoint returns `{status:'none'}` without fetching and the client renders the plain link. Setting `link_preview.blocked_hosts` (list, optional, default empty) for ops.

**Storage (migration, new file; the repo uses migrations for the API - ignore the db_update.sql memory note, that is a different project)**
`link_previews`: `id ulid pk`, `url_hash char(64) unique`, `url text`, `final_host varchar(255) null`, `status varchar(10)` (pending|ready|none), `title varchar(200) null`, `description varchar(400) null`, `site_name varchar(100) null`, `image_key varchar(255) null`, `fetched_at timestamptz null`, `expires_at timestamptz null`, timestamps. Global (not per workspace): content is public-page metadata fetched anonymously. TTL ready 24 h, none 1 h, pending 60 s (stale pending is retried). Daily pruning command deletes rows+images older than 7 d (schedule in routes/console.php; dev to follow existing scheduler style).

**`SafeUrlFetcher` (new, apps/api/app/Domain/LinkPreview/SafeUrlFetcher.php) - the SSRF contract**
1. Per HOP (initial URL and each redirect, max 3 redirects, `allow_redirects=false`, follow manually): scheme in {http,https}; no userinfo; port in {80,443}; host not IP-literal unless public; resolve BOTH A and AAAA (`dns_get_record`), fail closed when resolution yields nothing; EVERY returned address must be public. Block: 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl. 169.254.169.254 metadata), 172.16/12, 192.0.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255, ::/128, ::1, ::ffff:0:0/96 (unwrap mapped and re-test the v4), 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32, plus decimal/octal/hex IPv4 literals normalised via `inet_pton` after `ip2long` tricks (reject anything not a canonical dotted quad or valid IPv6).
2. **DNS-rebinding defence:** connect to the validated IP via cURL `CURLOPT_RESOLVE` (`host:port:ip`) while keeping Host/SNI = original host; never let cURL resolve again. Disable proxies (`CURLOPT_PROXY=''`), `CURLOPT_PROTOCOLS = HTTP|HTTPS`, `CURLOPT_REDIR_PROTOCOLS` same, no cookie jar, no auth, fixed `User-Agent: BananaChatLinkPreview/1.0`, `Accept: text/html,application/xhtml+xml`.
3. Limits: connect timeout 3 s, total 5 s per hop (10 s overall), response streamed with a hard cap of 512 KB (stop reading at `</head>` or cap), `Accept-Encoding: identity` OR enforce decoded cap (anti zip-bomb), `Content-Type` allowlist `text/html`, `application/xhtml+xml`; redirects to a different scheme allowed only http->https.
4. Parse with `DOMDocument` + `libxml_use_internal_errors`, `LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING`, never `LIBXML_NOENT/DTDLOAD`. Fields: `og:title|twitter:title|<title>`, `og:description|twitter:description|meta description`, `og:site_name|host`, `og:image|twitter:image`. All values `strip_tags`, whitespace-collapsed, truncated (200/400/100). Plain text only - the client renders text nodes; never HTML.
5. Image (og:image): resolve relative to final URL, same `SafeUrlFetcher` rules, content-type `image/jpeg|png|webp|gif` only (NO svg), <= 2 MB, magic-byte sniff, re-encode to WebP max 640 px width via the same image routine the attachment thumbnails use (dev: reuse the media derivation service; if it only works from an Attachment row, add a small standalone helper) and store on the media disk at `link-previews/{url_hash}.webp`. **Viewers never load third-party images** (no IP/tracking leak, no mixed content). Image failure = card without image, not `none`.
6. Egress defence in depth: run the `previews` queue worker in its own container/service with a firewall rule denying RFC1918 + link-local + the docker bridge (infra/docker-compose + nginx notes go to the infra owner; dev adds the compose service, DEC-100 documents the requirement).
7. Logging: log `url_hash`, status, reason code, duration; never log bodies; audit not required.
Residual risk to record in DEC-100: a GET is sent to an arbitrary public URL when any member's client renders the link; one-time-use public links (password reset, magic links) pasted into chat could be consumed by the unfurl. Mitigations: skip URLs whose path/query contains a token-looking segment (>=32 chars of [A-Za-z0-9_-] or 64 hex) -> `none`; the `link_preview.enabled` kill switch; only ONE URL per message previewed.

### B4 Public links
- Meeting (`/meet/<64hex>`): internal card with Join (B5.5). Covered.
- `/support/<code>`: **do NOT card, do NOT fetch** (code = visitor identity, bearer; PublicChatService.php:116). Recommended final behaviour: plain clickable text exactly as today (it falls into `internal-plain`). A generic "customer chat link" card adds no value (staff use `/public-chat/:roomId`) and would normalise pasting bearer links. **OPEN QUESTION FOR THE CUSTOMER:** do they want any card for `/support` links? Default = no.
- `/join/<token>`: same, plain text, never fetched.

### B5 Web design

**B5.1 chat-core (platform agnostic, Vitest)**: `packages/chat-core/src/link-cards.ts` exporting `classifyLink`, `extractLinkCards`, `ticketLinkUrl(origin, ticketId, slug)`, `ticketReturnPath(value)`, `linkPreviewLabel(body, appOrigins)` (for the room-list prettifier). Re-export from index.ts. `ticketReturnPath` validates `^/board/<ULID>(\?ws=<slug>)?$` for the login return fix.

**B5.2 shared/api-client**: types `TicketCard` (API-240 shape), `LinkPreview` (`{status:'ready'|'none'|'pending', url, title?, description?, site_name?, image_url?, image_expires_at?, fetched_at?}`). Endpoints `ticketCard(slug, id)`, `linkPreview(slug, url)`.

**B5.3 Card placement**: `MessageLinkCard` rendered by MessageItem directly under the body `<div className="bc-markdown">` (MessageItem.tsx:482). Not for deleted/pending/editing rows, not for system rows. If the entire trimmed body is just the one URL, the raw text line is hidden visually behind the card but remains in the accessible name/`title`/copy (the card is itself an `<a>` to the URL). If there is a note, the note shows normally and the card below.

**B5.4 TicketCard** (`TicketLinkCard.tsx`)
- Query: `useQuery(['kanban', wid, me.id, 'card', ticketId])`, `endpoints.ticketCard(slug, id)`, `slug` = link `ws` if present else current workspace slug, `wid` resolved from `session.workspaces` by slug (if `ws` is not one of the viewer's workspaces -> render "unavailable" WITHOUT any request). `staleTime 15s`, `retry:false` on 403/404, `refetchInterval 30000` only while the card is in viewport (IntersectionObserver `enabled`), `refetchOnWindowFocus: true`.
- Shows: `ticketKey(slug, number)`, title, lane chip (colour from lane.color; done style when is_done), priority, assignee initials/name, due (with `deadlineState` overdue style), workspace name label when `ws` differs from current workspace. Click -> `navigate('/board/{id}?ws={slug}')` (SPA; handles workspace switch via B5.7).
- States: loading skeleton (fixed height, no layout jump); 403/404/ws-unknown -> "Ticket unavailable" (single message, no distinction); network error with cached data -> data + "may be out of date" marker; `data-testid="ticket-link-card"`, `data-state="loading|ready|unavailable|stale"`.
- Hydrate only near viewport (IntersectionObserver rootMargin 200px) so a long scroll does not fire dozens of requests.

**B5.5 MeetingLinkCard** (`MeetingLinkCard.tsx`)
- `useQuery(['meeting-lobby', code])` -> `endpoints.meetingLobby(code)` (existing, unauth). `staleTime 60s`, no polling, `retry:false`. Shows title, "expires {time}" (`toLocaleString(locale)`), "up to {capacity} people", Join `<a href="/meet/{code}" target="_blank" rel="noopener noreferrer">`. 410 -> "Meeting ended" + disabled Join; 404 -> "Meeting not found" disabled; 503 / other error -> degrade to a plain link (no card). Never logs/pushes the code beyond the body.
- `data-testid="meeting-link-card"`, `data-state="live|ended|missing"`.

**B5.6 ExternalLinkCard** (`ExternalLinkCard.tsx`) - kind `external` only
- `useQuery(['link-preview', urlHash-or-url])` -> `endpoints.linkPreview(slug, url)`; on `pending` re-poll with backoff 1.5 s, 3 s, 6 s (max 3), then give up silently (plain link). `none`/error -> plain link only. `ready` -> card: site name, title, 3-line description clamp, image via `<img loading="lazy" referrerPolicy="no-referrer" src=image_url>` (our signed URL; refetch when `image_expires_at` passed), whole card is `<a target=_blank rel="noopener noreferrer nofollow">`; every field rendered as text.
- Disabled when `link_preview.enabled` false (server returns none).
- `data-testid="link-preview-card"`.

**B5.7 Live sync for ticket cards** (`hooks/useBoardLiveSync.ts`)
- Ref-counted subscriber per workspace id: first TicketLinkCard for workspace W mounts `echo.private('workspace.'+W).listen('.board.changed', fn)`, last unmount stops listening (same API as BoardPage.tsx:100-110; EchoProvider wraps the whole app so ChatView has `useEcho()`). `fn` debounces 400 ms then `queryClient.invalidateQueries({queryKey:['kanban', W, me.id, 'card']})` (react-query dedupes: one request per distinct ticket on screen, only ACTIVE (mounted) queries refetch). Does not invalidate lanes/tickets/ticket (BoardPage does its own).
- Listener for a non-current workspace requires channel auth = member; non-member auth failure is swallowed (card is "unavailable" anyway).
- Missed events: 30 s in-viewport poll + window focus refetch (same recovery contract as FR-KAN-005).
- Target < 2 s after a lane move on a healthy connection (broadcast + 400 ms debounce + one GET).

**B5.8 Room-list preview** (RoomList.tsx / chat-core room-list-presentation): `previewFor(body)`: a body whose first URL classifies ticket -> "🎫 Ticket" (th) / "Ticket", meeting -> "📹 Meeting", else unchanged. i18n keys below. Server `previewText` unchanged.

**B5.9 Board side (ask 1 + 2)** in `BoardPage.tsx`/new components
- Ticket drawer header (`TicketDetails`, next to "Edit ticket"): `Copy link` button (`navigator.clipboard.writeText(ticketLinkUrl(location.origin, ticket.id, slug))`, "Copied" `role=status` 1.5 s; fallback: select-all in a read-only input) and a visible read-only link field; `Share to chat` button -> `ShareTicketDialog`. Disabled with tooltip when workspace status is archived.
- `ShareTicketDialog.tsx`: `<dialog>` modal (same pattern/classes as ForwardDialog), `useRooms(slug)`, search, SINGLE-select list (multi-room is out of scope; one room per share), optional note textarea (max 500), Send. Send = `endpoints.sendMessage(slug, roomId, {client_message_id: uuid generated ONCE per dialog open and reused on retry, body: note ? note+'\n'+url : url})`; success -> toast "Shared to {room}" with link to room, invalidate `['rooms', slug]` and `['messages', roomId]`. Errors: 403 ROOM_NOT_MEMBER, 410 ROOM_EXPIRED, 403 WS_ARCHIVED, 429, network - each mapped to an i18n message; retry keeps client_message_id (idempotent: no duplicate).
- Eligible rooms: all rooms from `useRooms` (already member-only, expired secrets filtered); secret rooms allowed (data stays hidden); no extra API.
- Deep link (`/board/:ticketId?ws=slug`): new wrapper `useBoardDeepLink` in BoardPage's outer `BoardPage` component BEFORE rendering `Board`: if `ws` present and != current slug: if `ws` in `session.workspaces` -> `switchWorkspace(ws)` once (guard with ref) and render nothing until current matches; else render a notice "You do not have access to this ticket" with a Back to board button (no data, no request). Missing ticket/403/404 in drawer -> drawer shows "Ticket not found" (replace the raw `detail.error.message` at BoardPage.tsx:~345 for 404/403). The `?ws` param is kept in the URL (so refresh works); `navigate('/board')` closing the drawer drops it.
- Login return: `AppShell.tsx:110` change `Navigate to="/login"` to `/login?returnTo=<encodeURIComponent(path+search)>` when path matches `ticketReturnPath` or `meetingReturnPath`; `LoginPage.tsx:26` uses `meetingReturnPath(v) ?? ticketReturnPath(v) ?? '/'`. Open-redirect safe because both functions are whitelist regexes.

**B5.10 i18n** (packages/shared/i18n/th.json + en.json; keys must exist in BOTH, `shared.test.ts` already checks parity): 
`board.share`, `board.shareTitle`, `board.shareNote`, `board.shareSend`, `board.shareDone` ({room}), `board.shareError`, `board.shareErrorMember`, `board.shareErrorExpired`, `board.shareErrorArchived`, `board.shareErrorRate`, `board.copyLink`, `board.copied`, `board.ticketLink`, `board.ticketNotFound`, `board.noAccess`, `chat.ticketCardLoading`, `chat.ticketUnavailable`, `chat.ticketStale`, `chat.ticketWorkspace` ({name}), `chat.ticketUnassigned`, `chat.ticketDue` ({time}), `chat.meetingCardExpires` ({time}), `chat.meetingCardCapacity` ({count}), `chat.meetingJoin`, `chat.meetingEnded`, `chat.meetingMissing`, `chat.linkPreviewOpen`, `room.previewTicket`, `room.previewMeeting`. Thai copy suggestions: แชร์ไปแชท / คัดลอกลิงก์ / คัดลอกแล้ว / ไม่พบตั๋วหรือไม่มีสิทธิ์เข้าถึง / ตั๋วไม่พร้อมใช้งาน / ข้อมูลอาจไม่ล่าสุด / เข้าร่วม / ประชุมสิ้นสุดแล้ว. The board page is currently English-only; new board strings still go through `useChatText().text()` (mixed-language board is a known pre-existing gap, do NOT translate the rest of the board in this work).

### B6 Events
No new event, no payload change. `board.changed` (EVT-064) stays content-free; `message.created` unchanged (a share is a normal text message). Document in spec: cards listen to EVT-064.

### B7 Authorization summary
| Case | Result |
|---|---|
| Share into a room | `membershipOrFail` in `MessageController::store` (existing). No ticket check server-side: the body is just text; the card re-authorises per viewer. |
| Viewer in room but not member of ticket workspace | API-240 -> 403 WS_FORBIDDEN -> "Ticket unavailable". |
| `ws` slug not among viewer's workspaces | no request, "unavailable". |
| Ticket id from another workspace under correct `ws` | 404 (workspace_id scope) -> "unavailable". |
| Archived workspace | read ok as today (verify), Share disabled; send gives WS_ARCHIVED -> mapped message. |
| Meeting lobby | unauth by design; 410/404 states. |
| Link preview | auth + membership of the current workspace; global cache; internal hosts refused. |

### B8 Edge/failure matrix (all must be tested)
no access / other workspace / ticket missing -> same "unavailable"; ticket moved lane -> live update; lane renamed -> live (lane embedded in API-240); same ticket many times -> one request; message edited to remove link -> card gone; message deleted -> no card, no fetch (guard `deleted_at`); forwarded copy -> body copied -> card; meeting expired/ended -> 410 card; meeting full -> only on Join (lobby), known limitation; calls disabled (503) -> plain link; offline -> stale marker; preview pending/none -> plain link; preview image fetch failed -> text-only card; secret chat -> allowed; `/support` and `/join` -> plain text, zero requests.

### B9 Test plan with ids
API (Pest) - new files
- `tests/Feature/Kanban/TicketCardTest.php`: TC-KAN-016 slim payload has no description/comments/history/attachments; TC-KAN-017 foreign-workspace ticket 404 under own ws, non-member 403, unauthenticated 401; TC-KAN-018 archived workspace behaviour equals `show`; TC-KAN-019 lane rename/move reflected, `board.changed` still dispatched by lane/ticket writes (existing events asserted), card endpoint does not create default lanes; TC-KAN-020 throttle.
- `tests/Feature/Message/LinkPreviewApiTest.php`: TC-MSG-084 validation (scheme, userinfo, port, length, non-URL) 422; TC-MSG-085 internal hosts (APP_URL host, /board, /meet, /support, /join) 422; TC-MSG-086 cache hit/miss/negative cache, one job per URL under concurrency (lock); TC-MSG-087 unauth 401; TC-MSG-088 throttles; TC-MSG-089 `link_preview.enabled=false` returns none and dispatches nothing; TC-MSG-090 sensitive-token URLs skipped.
- `tests/Unit/SafeUrlFetcherTest.php` (inject fake resolver + fake HTTP): TC-MSG-091 every blocked range incl. 169.254.169.254, ::1, ::ffff:127.0.0.1, 100.64.0.1, decimal/hex/octal literals; TC-MSG-092 mixed A (public) + AAAA (private) answer rejected; TC-MSG-093 redirect to private host blocked on hop 2, redirect cap 3, https->http downgrade blocked; TC-MSG-094 DNS rebinding: second resolution never used (CURLOPT_RESOLVE pinned); TC-MSG-095 size cap, content-type allowlist, timeout; TC-MSG-096 parser: HTML injection stays text, og fields, entity expansion (XXE/billion laughs) harmless; TC-MSG-097 image: svg rejected, non-image magic bytes rejected, oversize rejected, re-encoded WebP stored.
- `FetchLinkPreview` job test TC-MSG-098: success/none/pending-timeout recovery, image failure still ready.
- Meeting lobby regression (existing tests/Feature/Meeting): TC-MEET-CARD-001 response shape unchanged (title, expires_at, capacity, identity) - guard against future leaks.
chat-core (Vitest, `packages/chat-core/src/link-cards.test.ts`): TC-CORE-069 classify ticket (with/without ws, lower/upper ULID, wrong origin, extra params), TC-CORE-070 meeting regex, TC-CORE-071 `/support` & `/join` & other app paths -> internal-plain, TC-CORE-072 first-link-wins and code-fence skipping and `[text](url)` links, TC-CORE-073 `ticketReturnPath`/`meetingReturnPath` whitelist (reject `//evil`, `/board/x`, `javascript:`), TC-CORE-074 ticketLinkUrl round trip, TC-CORE-075 room-list preview label. api-client: TC-API-CLIENT-CARD-001 endpoint paths/headers (packages/api-client/test/client.test.ts). shared: i18n parity (existing test).
Web Playwright (`apps/web/e2e/ui/`, API mocked): 
- `ticket-share.spec.ts` (390 + 1440 widths): TC-WEB-TSHARE-001 drawer shows link + Copy (clipboard content equals `{origin}/board/{id}?ws={slug}`), TC-WEB-TSHARE-002 Share dialog lists rooms, search, send posts exactly one `POST /rooms/{id}/messages` with body URL (+note), idempotent retry reuses client_message_id, TC-WEB-TSHARE-003 archived workspace disables Share, TC-WEB-TSHARE-004 error mappings, TC-WEB-TSHARE-005 deep link with `ws` of another member workspace switches workspace and opens drawer, TC-WEB-TSHARE-006 `ws` of a non-member workspace shows no-access and fires NO ticket request, TC-WEB-TSHARE-007 missing ticket 404 -> "Ticket not found", TC-WEB-TSHARE-008 logged-out deep link -> login -> returns to ticket URL.
- `link-cards.spec.ts`: TC-WEB-LINK-001 ticket URL in message -> card with key/title/lane/assignee, click opens board drawer; TC-WEB-LINK-002 pushing a mocked `board.changed` over the synthetic socket makes card show new lane within 2 s, with exactly one GET for N duplicate cards; TC-WEB-LINK-003 unavailable states (403, 404, unknown ws) identical text, no title; TC-WEB-LINK-004 stale marker offline; TC-WEB-LINK-005 meeting card live/ended/missing/503, Join opens `/meet/{code}` in new tab; TC-WEB-LINK-006 `/support/<code>` and `/join/<token>` render plain, zero requests to link-preview/lobby; TC-WEB-LINK-007 external ready card (title/description/image from OUR url, `referrerpolicy`, rel), pending->ready poll, none -> plain link, internal-origin URL never calls preview; TC-WEB-LINK-008 edited message drops card, deleted shows none; TC-WEB-LINK-009 forwarded message keeps card; TC-WEB-LINK-010 viewport-lazy hydration (offscreen cards issue no request until scrolled); TC-WEB-LINK-011 room list shows "Ticket"/"Meeting" prefix; TC-WEB-LINK-012 no horizontal scroll at 320/390/1440 and dark mode contrast >= 4.5 (reuse luminance helper from forward.spec.ts).
Manual QA script (not automated): real Reverb lane move across two browsers; real fetch against a public page and a page redirecting to 127.0.0.1 / metadata IP on staging; mobile app opens a room containing a ticket URL without error.

### B10 Work split (disjoint file ownership; each slice a different dev)
**S0 Foundation (do FIRST, small, merges before others start coding against it)**: 
- packages/shared/src/types.ts, packages/shared/i18n/en.json, th.json; packages/api-client/src/endpoints.ts (+ client.test.ts); packages/chat-core/src/link-cards.ts, link-cards.test.ts, index.ts, room-list-presentation.ts; apps/api/routes/api.php (BOTH new routes, pointing at `KanbanController@card` and `LinkPreviewController@show`); apps/api/app/Providers/AppServiceProvider.php (limiters `board-card`, `link-preview`); apps/api/app/Services/SettingsService.php (`link_preview.*`); stub file apps/web/src/components/links/ExternalLinkCard.tsx with the final props signature `({url}) => JSX`; PRODUCT_SPEC.md (FR-KAN-007, FR-MSG-013, DEC-100, API-240/241, TC rows, changelog 1.19.0, §4 `metadata` line unchanged).
**S1 API ticket card**: apps/api/app/Http/Controllers/Api/V1/KanbanController.php (add `card` + serializer helper), apps/api/tests/Feature/Kanban/TicketCardTest.php.
**S2 API link preview**: apps/api/app/Http/Controllers/Api/V1/LinkPreviewController.php, apps/api/app/Domain/LinkPreview/* (SafeUrlFetcher, HostPolicy, OgParser, ImageStore), apps/api/app/Jobs/FetchLinkPreview.php, apps/api/app/Models/LinkPreview.php, migration `2026_10_10_000001_create_link_previews_table.php`, console schedule prune command file, infra/docker-compose queue worker service for `previews` (infra files), tests/Feature/Message/LinkPreviewApiTest.php, tests/Unit/SafeUrlFetcherTest.php, tests/Feature/Message/FetchLinkPreviewJobTest.php.
**S3 Web cards in chat**: apps/web/src/components/links/MessageLinkCard.tsx, TicketLinkCard.tsx, MeetingLinkCard.tsx, apps/web/src/hooks/useBoardLiveSync.ts, apps/web/src/styles/link-cards.css (imported by MessageLinkCard only), edits to apps/web/src/components/MessageItem.tsx (one render line under body + hide-url-only-body logic) and apps/web/src/components/RoomList.tsx (preview label).
**S4 Web board side**: apps/web/src/pages/BoardPage.tsx (Copy link, Share button, deep link gate, 404 text), apps/web/src/components/ShareTicketDialog.tsx, apps/web/src/styles/share-ticket.css, apps/web/src/components/AppShell.tsx (returnTo), apps/web/src/pages/LoginPage.tsx.
**S5 Web external preview card**: apps/web/src/components/links/ExternalLinkCard.tsx (replaces the S0 stub), apps/web/src/styles/external-link-card.css, hook apps/web/src/hooks/useLinkPreview.ts. (Mounted by S3 via the stable import; S5 never edits MessageItem.)
**S6 QA / automation**: apps/web/e2e/ui/ticket-share.spec.ts, link-cards.spec.ts, and ownership of apps/web/e2e/ui/fixtures.ts additions (no other slice edits fixtures.ts; if S3/S4 need a fixture they ask S6), Pest review of S1/S2 gaps.
Order: S0 -> {S1,S2,S3,S4,S5} in parallel -> S6 -> integration QA. S1 and S3/S4 integrate against the frozen JSON in B3; S6 mocks the same JSON so it does not wait on API.

### B11 Deviation risks a dev could hit (read before coding)
R1 **Origin matching.** Cards only upgrade URLs whose origin is the current web origin or in `VITE_APP_ORIGINS`. A link copied from prod pasted into staging stays a plain link (intended). Do NOT loosen to "any host with /board/<ulid>" - that would send the viewer's credentials (X-Workspace-Id) nowhere harmful but would create fake cards for third-party URLs and unfurl them wrongly.
R2 **Never put cards inside `Markdown`.** It is shared with AI chat, tickets and (via the parser) the public visitor surfaces. Cards in the visitor page would call authenticated endpoints without a session.
R3 **Do not add a message `type`/`metadata` output** or touch `MessageWriter`/`MessageSerializer`/`MessageType`. The whole point is zero server message change; mobile and search depend on it.
R4 **Workspace comes from the slug, never from the ticket id.** Card requests send `X-Workspace-Id: <ws slug>`; if `ws` is absent use the CURRENT workspace slug, never "try all workspaces".
R5 **No ticket content anywhere** except the API-240 response held in react-query cache: do not copy title into the message body, notifications, room preview, or `localStorage`/IndexedDB room cache (`roomCache` persists room previews; the preview stays the URL/"Ticket" label).
R6 **Query key scope.** Card key `['kanban', wid, me.id, 'card', id]` must include `me.id` (logout/switch leakage) and be invalidated by `board.changed`; invalidating the broader `['kanban', wid]` from the chat page is forbidden (it would refetch lanes/tickets in the background).
R7 **Echo listener leak.** Ref-count per workspace; always `stopListening` the same handler. Do not `echo.leave()` the channel (BoardPage and others share it).
R8 **SSRF fetcher.** Do not use `Http::get`/Guzzle redirects, `gethostbyname` (IPv4 only), or the `OpenAiCompatibleProvider` guard. Validate every hop, pin IP with CURLOPT_RESOLVE, treat unresolvable as blocked (fail closed), return uniform `none`. No exception text or hostnames in API responses.
R9 **Preview endpoint must never be called for ticket/meeting/app-origin URLs**, and the server must also refuse them (defence in depth) - the client check alone is insufficient.
R10 **Images are proxied/re-encoded, never hotlinked.** No `<img src=thirdparty>`; no SVG.
R11 **Login return redirect** must stay a whitelist (`ticketReturnPath`/`meetingReturnPath`); never accept an arbitrary `returnTo`.
R12 **FR-KAN-006 is taken** (images). Using it again corrupts the spec traceability matrix.
R13 **Mixed language.** Board is English hard-coded; only NEW strings use i18n. Do not "fix" the rest.
R14 **SQLite hides PG problems.** The migration and any JSON/`ilike` usage must be reviewed against Postgres; use portable column types, test unique index behaviour, and do not rely on SQLite leniency.
R15 **Archived workspace reads.** Confirm with a test what `workspace.context` does for GET on archived workspaces before promising "card still works"; the card must degrade to "unavailable" if 403.
R16 **Share is not a forward.** Do not route through `MessageForwarder` (it requires a source message and sets `forwarded_from`); a share is a first-class new message by the sharer.
R17 **Throttles.** The room can contain many cards; per-user 240/min for cards is a ceiling, but the viewport-lazy hydration and react-query dedupe are what keep real usage low - do not remove them.
R18 **One-time-link consumption** by unfurl is a documented residual risk (B3 SafeUrlFetcher); keep the token-looking-path skip and the kill switch.

### B12 Contradictions with the PO brief (summary)
1. FR-KAN-006 id already used -> FR-KAN-007.
2. Card hydration: new slim read endpoint API-240 instead of "existing `GET /board/tickets/{id}`" (payload weight, lane name/colour absent, write side effect of `GET /board`).
3. External links: now DO get previews (customer update) - requires a new authenticated endpoint API-241, DB table, queue, SSRF fetcher; PO AC-12/AC-15 ("no new endpoint", "no server fetch") are superseded; AC-15's "no new UNAUTHENTICATED endpoint / no new broadcast" still holds.
4. AC-13: exactly one card per message (first link), not ticket+meeting together.
5. AC-9 premise: the deep link does NOT currently survive login (LoginPage only honours /meet returnTo) - extra work in S4.
6. AC-14: /support and /join are not carded and also hard-blocked from the unfurler; whether the customer wants any /support card is an open question (default no).
7. Meeting card cannot show "full" (lobby has no participant count); Join opens in a NEW TAB because /meet lives outside the call providers.
8. The PO's "message stores only {ticket_id, workspace_id}" is realised as `{slug, ticket id}` inside the body URL (no `metadata` column used), which is what keeps mobile/search/forward safe.
