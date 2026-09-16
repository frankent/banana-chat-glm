# Public Chat (FR-PCHAT) — accepted design

Chosen from three competing architectures by three adversarial judges (fidelity / security /
codebase-fit). Two of three selected this one. Arbitration: for an UNAUTHENTICATED customer-facing
surface, structural isolation beats scattered `type != 'support'` guards whose failure mode is a
silent leak of internal workspace messages. The rejected alternative required nullable-ing
`MessageWriter::write(User $sender)` — the hottest correctness-critical path in the product — plus
seven separate exclusions with no central chokepoint.

THIS FILE IS THE IMPLEMENTATION CONTRACT. Where it conflicts with an agent's instinct, it wins.

---

## Summary

Public Chat is built as a separate bounded context with its own tables (`public_chat_rooms`, `public_chat_messages`, `public_chat_message_attachments`, `public_chat_api_keys`), its own two serializers, its own two broadcast channels and its own three controller tiers — nothing is added to `rooms` or `messages`. The payoff is structural rather than defensive: because a public chat room is not a `rooms` row, `RoomController::index`, `SearchController::memberRoomIds`, `CallService::allowed`, the `room.{roomId}` channel callback, `RoomPolicy`, `MessageEditor`, `Jobs/NotifyMessage`, `workspaceUnread`, `GenerateRoomBotReply` and the `RoomType` enum are all untouched, where a shared-table design would have had to teach five independent membership gates about a new room type with a silent leak as each one's failure mode. "No calls, no meetings" likewise needs no gate — `CallService::allowed()` joins `rooms`, so a public chat room id simply does not resolve, and on the web the visitor page mounts outside `CallProvider`. The customer integrates over three HMAC-signed routes under `/api/v1/partner/public-chat/` that create a room from `{customer_name, provider_name, external_ref, locale, meta}` and return a `/support/<64-hex>` link; the 64-hex code is the visitor's only credential. Visitor-message idempotency is solved by making `client_message_id` NOT NULL with `UNIQUE(room_id, client_message_id)` — no column of the key is nullable, so the Postgres NULL-distinct hole that makes the existing `messages(room_id, sender_id, client_message_id)` index inert for visitor rows cannot arise. Auto-claim runs inside the same `lockForUpdate` transaction that assigns `seq`, making "exactly one claim" a database guarantee under concurrent replies. Internal identity is kept off the customer surface at the wire level, not just the serializer level: `private-public-chat.{rid}` carries only the public payload and `private-public-chat-staff.{rid}` carries the internal one, so agent messages render externally as `provider name (admin username)` from write-time snapshots that never join `users`. The one duplication this design explicitly declines is the media pipeline — `attachments` and `UploadService` are reused, partitioned by a new nullable `public_chat_room_id`, because forking mime sniffing, extension blocking and size caps would guarantee drift in exactly the checks that matter. Two corrections to the brief that change implementation: Filament is **v3.3.55**, not v4 (`composer.lock:1373`, `PRODUCT_SPEC.md:139`), and Decision C's "stored hashed" is amended to `Crypt::encryptString` because HMAC verification must recompute the MAC with the key and a digest cannot supply one.

## Data model

All migrations new unless marked ALTER. Highest existing DEC is 059, API 164, EVT 070.

M1 `public_chat_api_keys` — FR-PCHAT-030
  id ulid pk | workspace_id foreignUlid->workspaces cascadeOnDelete | name varchar(80)
  key_id char(32) UNIQUE — 'pck_' + 28 lowercase hex; public identifier, safe to log
  secret_ciphertext text — Crypt::encryptString(plaintext), model $hidden (DEC-062)
  secret_last4 char(4) — display only, '****abcd', mirrors AiProvider.api_key_last4
  created_by_admin_id foreignUlid->users nullOnDelete | last_used_at | revoked_at | timestampsTz
  INDEX (workspace_id, revoked_at)
  WHY key_id separate from secret: the signature header names a key without revealing it, and revocation is a row update so the audit trail survives.

M2 `public_chat_rooms` — FR-PCHAT-001
  id ulid pk | workspace_id foreignUlid->workspaces cascadeOnDelete
  api_key_id foreignUlid->public_chat_api_keys nullOnDelete — provenance only
  code char(64) UNIQUE — bin2hex(random_bytes(32)); the visitor credential (DEC-063)
  customer_name varchar(120) | provider_name varchar(120)
  status varchar(12) default 'new' — new|in_progress|done|problem
  assigned_to foreignUlid->users nullOnDelete | claimed_at timestampTz null
  external_ref varchar(120) null — customer's own ticket id
  meta jsonb null — the "...etc data with payload"; NEVER served to the visitor
  locale char(2) default 'th' — FR-I18N-001 default
  last_seq int default 0 | last_visitor_seq int default 0 | last_agent_seq int default 0
  last_message_at | expires_at | closed_at null | timestampsTz + softDeletes
  INDEX (workspace_id, status, last_message_at DESC) — serves list + status filter
  INDEX (workspace_id, assigned_to) — serves assignee filter
  UNIQUE partial (workspace_id, external_ref) WHERE external_ref IS NOT NULL — API-200 create idempotency. Deliberately excludes api_key_id: a key rotation (revoke+issue) changes api_key_id, and including it would make the customer's retry-after-rotation create a duplicate room.
  NO WorkspaceScope global scope on this model. Deliberate: WorkspaceScope no-ops silently when context is unset (Models/Scopes/WorkspaceScope.php:20), which on an unauthenticated route is a silent cross-tenant leak. Requiring an explicit ->where('workspace_id',...) turns a forgotten filter into a visible bug instead of an invisible one.

M3 `public_chat_messages` — FR-PCHAT-002
  id ulid pk | room_id foreignUlid->public_chat_rooms cascadeOnDelete
  workspace_id foreignUlid->workspaces cascadeOnDelete — DENORMALISED defence-in-depth: every query also filters workspace_id, so even a wrong room_id join cannot cross tenants
  seq integer
  sender_kind varchar(8) — visitor|agent|system
  sender_user_id foreignUlid->users nullOnDelete — null for visitor and system
  agent_username_snapshot varchar(64) null | provider_name_snapshot varchar(120) null
  type varchar(8) — text|image|video|file|system (no call/meet types exist here)
  body text null
  system_event varchar(24) null — claimed|reassigned|status_changed|closed_by_customer
  system_meta jsonb null — {from,to,actor_username}; system rows have body NULL so each serializer renders the text in the READER's locale (baking a Thai string into body would be unreadable to an 'en' visitor)
  client_message_id varchar(64) NOT NULL (DEC-066)
  created_at | deleted_at null | deleted_by foreignUlid->users nullOnDelete
  UNIQUE (room_id, seq) | UNIQUE (room_id, client_message_id) | INDEX (room_id, seq DESC)
  WHY SNAPSHOTS: the public serializer computes the external display name from provider_name_snapshot + agent_username_snapshot and NEVER joins `users`. A later username change or provider rename does not retroactively rewrite the customer's transcript, and a buggy join cannot leak a user row onto the public surface.

M4 `public_chat_message_attachments`
  message_id foreignUlid->public_chat_messages cascadeOnDelete | attachment_id foreignUlid->attachments cascadeOnDelete | position unsignedSmallInteger default 0 | PRIMARY (message_id, attachment_id)
  WHY separate from `message_attachments`: that pivot FKs to `messages`. Reusing it would require making that FK nullable or polymorphic — the exact contamination this design exists to prevent.

M5 ALTER `attachments` — FR-PCHAT-020, the ONE shared surface (DEC-068)
  uploader_id -> nullable (drop NOT NULL, keep FK cascadeOnDelete)
  ADD public_chat_room_id foreignUlid->public_chat_rooms nullOnDelete, nullable + INDEX
  Verified consumer list for the nullable change:
   - UploadService::complete() :119-121 `if ($attachment->uploader_id !== $uploader->id)` — BLOCKING; needs a sibling `completeForPublicChat(Attachment $a, PublicChatRoom $room)` asserting public_chat_room_id === $room->id, because the visitor complete call has no User. New creator method: `UploadService::createForPublicChat(PublicChatRoom $room, array $input)` — do NOT make `create(User $uploader, ...)` nullable across all callers.
   - ProcessAttachment.php:135 — audit-log jsonb payload only, null-safe.
   - AttachmentProcessed.php:29 — covered by EVT-084.
   - MessageWriter.php:175, RoomToolsController.php:56, BoardService.php:122 — all compare `uploader_id === $actor->id`. NULL never equals a ULID, so all three are NATURALLY FAIL-CLOSED against visitor uploads. The explicit `->whereNull('public_chat_room_id')` guard in MessageWriter::claimAttachments is belt-and-braces, not the only defence.
   - Attachment::uploader() returns null; no serving path dereferences it. AiController:853 sets its own non-null uploader_id, unaffected.
  Partition invariant enforced on BOTH sides: internal claim adds ->whereNull('public_chat_room_id'); public claim requires public_chat_room_id === $room->id with a room-scoped (not uploader-scoped) ownership test.

## API contract

All errors use the existing §7 envelope {error:{code,message,details,request_id}} via App\Exceptions\ApiException + the renderer at bootstrap/app.php:60-70.

NEW ApiException factories: apiKeyInvalid() 401 | apiSignatureInvalid() 401 | apiTimestampSkew(int) 401 | apiNonceReplayed() 409 | pchatDisabled() 503 | pchatRoomClosed() 409 | pchatLinkExpired() 410 | pchatRoomNotFound() 404 | pchatInvalidTransition() 422. Never throw AuthenticationException — bootstrap/app.php:79-87 renders it as AUTH_TOKEN_INVALID, misleading for a machine client with no token.

=== TIER 1 — customer server→server, HMAC ===
routes/api.php, NEW block OUTSIDE every auth:api group, immediately after the /public-meetings block (api.php:88-90):
Route::prefix('partner/public-chat')->middleware('api.hmac')->group(...)
The `partner/` prefix is load-bearing: without it, partner GET /public-chat/rooms/{code} and agent GET /public-chat/rooms/{id} are the same path in two middleware groups disambiguated only by regex constraints, and a dropped ->where() silently reroutes a customer request into the authenticated handler. It also gives OQ-PCHAT-003's nginx exemption a path to match on.

API-200 POST /api/v1/partner/public-chat/rooms — throttle:pchat-create
  req {customer_name*(1..120), provider_name*(1..120), external_ref?(<=120), locale?('th'|'en', default 'th'), meta?(object, <=8KB serialized)}
  201 {room:{code,status:'new',customer_name,provider_name,created_at,expires_at}, url:"https://<APP_URL>/support/<code>"}
  200 same body when external_ref matches an existing row (idempotent replay, not an error)
  errs 422 VALIDATION_FAILED | 401 API_KEY_INVALID / API_SIGNATURE_INVALID / API_TIMESTAMP_SKEW | 409 API_NONCE_REPLAYED | 503 PCHAT_DISABLED | 429
API-201 GET /api/v1/partner/public-chat/rooms/{code}
  200 {code,status,customer_name,provider_name,assigned_display_name|null,message_count,last_message_at,closed_at,expires_at} — returns the EXTERNAL display name only. Still answers when the feature is off.
API-202 POST /api/v1/partner/public-chat/rooms/{code}/close
  200 {status:'done', closed_at} | 409 PCHAT_ROOM_CLOSED if already closed
All Tier-1 routes ->where('code','[a-f0-9]{64}').
Verified: RequireMinimumAppVersion passes when X-App-Version is absent (middleware line 27 only compares a non-null, non-empty header), so the customer's server needs no exclusion.

=== TIER 2 — visitor, UNAUTHENTICATED. The code IS the credential ===
Same region of routes/api.php, every route ->where('code','[a-f0-9]{64}'). Every handler resolves the room by code, calls WorkspaceContext::set($room->workspace, null), AND filters workspace_id explicitly. Any Authorization bearer the shared ApiClient attaches (packages/api-client/src/client.ts:49) is IGNORED on this tier — an agent who opens the link is treated as the visitor (FR-PCHAT-013). Responses send Cache-Control: no-store.

API-210 GET /api/v1/public-chat/{code} — throttle:pchat-visitor-read
  200 {room:{code,customer_name,provider_name,status,locale,created_at}, can_send:bool, feature_enabled:bool, closed_reason:null|'done'|'disabled'}
  410 PCHAT_LINK_EXPIRED | 404 PCHAT_ROOM_NOT_FOUND
API-211 GET /api/v1/public-chat/{code}/messages?after_seq=&limit=(<=100)
  200 {messages:[PublicMessage], last_seq} — reconnect catch-up + polling fallback
API-212 POST /api/v1/public-chat/{code}/messages — throttle:pchat-visitor-write
  req {client_message_id*(1..64), body?, attachment_ids?[<=10]}
  201 {message:PublicMessage} | 200 + same body on idempotent replay
  409 PCHAT_ROOM_CLOSED | 503 PCHAT_DISABLED | 422 VALIDATION_FAILED
API-213 POST /api/v1/public-chat/{code}/uploads — throttle:pchat-visitor-upload
  req {kind:'image'|'video'|'file' (NEVER 'avatar' — 422 before UploadService is reached), filename, mime_type, size_bytes}
  201 upload ticket; attachment row gets uploader_id=NULL, public_chat_room_id=$room->id
API-214 POST /api/v1/public-chat/{code}/uploads/{attachment_id}/complete
API-215 POST /api/v1/public-chat/{code}/broadcasting/auth — throttle:pchat-visitor-read
API-216 POST /api/v1/public-chat/{code}/typing — throttle:pchat-visitor-write

=== TIER 3 — support agents ===
INSIDE the existing ['auth:api','account.active','password.fresh','workspace.context'] group. Authorisation = active WorkspaceMember of X-Workspace-Id, which that middleware already proves. Decision A: no room-level role, no room_members row, no new role.

API-220 GET /api/v1/public-chat/rooms?status=&assigned=&q=&needs_reply=&cursor=&limit=
  status: csv of new|in_progress|done|problem | assigned: ULID|'me'|'none' | q: ILIKE over customer_name/provider_name/external_ref
  200 {rooms:[StaffRoom], next_cursor} ordered last_message_at DESC NULLS LAST, id DESC
API-221 GET /api/v1/public-chat/rooms/{id}
API-222 GET /api/v1/public-chat/rooms/{id}/messages?after_seq=&before_seq=&limit=
API-223 POST /api/v1/public-chat/rooms/{id}/messages — throttle:pchat-agent-write; triggers AUTO-CLAIM; 409 PCHAT_ROOM_CLOSED | 503 PCHAT_DISABLED
API-224 PATCH /api/v1/public-chat/rooms/{id}
  req {status?, assigned_to?:ULID|null}; assigned_to must be an active WorkspaceMember of the same workspace else 422; 422 PCHAT_INVALID_TRANSITION (sole guard: cannot leave 'new' while assigned_to is null). Writes a system row inside the same lockForUpdate so the transcript records who changed what.
API-225 POST /api/v1/public-chat/rooms/{id}/uploads — uploader_id = the agent AND public_chat_room_id = the room
API-226 DELETE /api/v1/public-chat/messages/{id} — soft delete, any active workspace member, audited 'public_chat.message_deleted'. THIS IS WHY OWN TABLES: MessageEditor::assertDeletableBy (MessageEditor.php:134-148) falls to a moderator branch requiring RoomRole::Owner|Admin for a NULL-sender row, which would make visitor messages undeletable by anyone.
API-227 GET /api/v1/public-chat/summary → {new,in_progress,problem,mine} — feeds the rail badge.

NEW FILES (no shared base with RoomController/MessageController):
app/Http/Controllers/Api/V1/PublicChat/{PartnerRoomController,VisitorController,AgentRoomController}.php
app/Domain/PublicChat/{PublicChatService,PublicChatMessageWriter,PublicChatGate,PublicChatApiKeyService,PublicChatPublicSerializer,PublicChatStaffSerializer}.php

## HMAC scheme

Middleware app/Http/Middleware/VerifyPublicChatSignature.php, alias `api.hmac` registered in bootstrap/app.php next to account.active/password.fresh (lines 48-52). NOT a guard — Auth::viaRequest must return an Authenticatable and there is no User here.

CREDENTIAL FORMAT
  key_id  'pck_' + 28 lowercase hex (32 chars, char(32) UNIQUE). Public, safe to log.
  secret  'pcs_' + bin2hex(random_bytes(32)) (68 chars). Shown EXACTLY once.
  At rest: secret_ciphertext = Crypt::encryptString($secret) using APP_KEY; secret_last4 = last 4.

DEC-062 — AMENDS DECISION C's word "hashed". HMAC verification must recompute HMAC(secret, canonical); a sha256/bcrypt digest is mathematically unusable as a key, so "HMAC-signed" and "stored hashed" cannot both hold. The property the decision actually wanted — never retrievable through any UI or API after issuance — is preserved unchanged: no endpoint and no Filament field ever reads secret_ciphertext back out, the model $hidden's it, and the admin sees only ****last4. The at-rest boundary moves from "DB dump" to "DB dump AND APP_KEY", which is the boundary AiProvider.api_key_encrypted (app/Models/AiProvider.php:48-52) already accepts in this codebase.

HEADERS
  X-PChat-Key        key_id
  X-PChat-Timestamp  unix seconds (integer)
  X-PChat-Nonce      16..64 chars [A-Za-z0-9_-]
  X-PChat-Signature  "v1=" + lowercase hex HMAC-SHA256

WHAT IS SIGNED — canonical string, "\n"-joined, exactly 6 lines:
  v1
  <HTTP METHOD uppercase>
  <request path including the /api/v1 prefix, no query string>
  <X-PChat-Timestamp>
  <X-PChat-Nonce>
  <lowercase hex sha256 of the RAW request body bytes; sha256("") when no body>

Sign the RAW bytes via $request->getContent() — never re-serialised JSON. Re-serialising changes key order, whitespace and unicode escaping and produces intermittent, unreproducible signature failures. This is the single most common integration bug in this class of API; the customer-facing docs must say "sign the exact bytes you put on the wire".

VERIFICATION ORDER — fail-closed, cheapest first, and deliberately BEFORE the feature gate:
  1. headers present → 401 API_KEY_INVALID
  2. |now − timestamp| ≤ 300s → 401 API_TIMESTAMP_SKEW {skew_seconds, server_time}
  3. key_id lookup, revoked_at IS NULL, workspace status active → 401 API_KEY_INVALID
  4. sig = hash_hmac('sha256', $canonical, Crypt::decryptString($row->secret_ciphertext));
     hash_equals($sig, $presented) → 401 API_SIGNATURE_INVALID (constant time)
  5. Cache::add('pchat:nonce:'.$key_id.':'.hash('sha256',$nonce), 1, 600) === false → 409 API_NONCE_REPLAYED.
     TTL 600s > 2× the 300s skew window, so any replay still inside the accepted window is guaranteed to find the nonce cached. Redis — the same store SettingsService uses.
  6. WorkspaceContext::set($key->workspace, null) — app/Support/WorkspaceContext.php:19 accepts a null membership — then $key->forceFill(['last_used_at'=>now()])->saveQuietly()
  7. ONLY NOW the controller calls PublicChatGate::assertEnabled() → 503 PCHAT_DISABLED.
     Order matters twice: an unauthenticated prober must not learn whether the feature is on, and a legitimate customer must get a clean retriable 503 rather than a misleading 401.

CLOCK SKEW ±300s. REPLAY DEFENCE = the nonce cache in step 5, whose TTL is tied to the skew window so the two cannot drift apart.

KEY STORAGE is never exposed: Model $hidden = ['secret_ciphertext']; the Filament resource shows key_id and '****'.secret_last4 only; the plaintext exists solely in the one-time Notification at issuance.

RATE LIMITING — NAMED limiters registered via RateLimiter::for in app/Providers/AppServiceProvider.php:50-74:
  'pchat-create'         Limit::perMinute(60)->by($request->header('X-PChat-Key') ?: $request->ip())
  'pchat-visitor-read'   Limit::perMinute(120)->by($code)
  'pchat-visitor-write'  Limit::perMinute(20)->by($code)
  'pchat-visitor-upload' Limit::perMinute(10)->by($code)
  'pchat-agent-write'    Limit::perMinute(60)->by($request->user()->id)
Named, NOT numeric: routes/api.php:192 already documents that stacked numeric throttle:N,1 share one cache key per resolved user-or-IP across every numeric-throttled route on the domain. Keying Tier 1 by key_id rather than IP is load-bearing — the customer calls from ONE server IP.

## Realtime

TWO channels, two event classes, two serializers (DEC-065). Internal identity is NEVER published on a channel a visitor can subscribe to — the isolation boundary is enforced at the wire, not only in the serializer.

  private-public-chat.{room_id}        visitor + agents mirroring; PUBLIC payload only
  private-public-chat-staff.{room_id}  agents only; INTERNAL payload
  private-workspace.{wid}              existing channel, carries list-level room events

AGENT AUTHORISATION — routes/channels.php, two NEW callbacks:
  Broadcast::channel('public-chat.{roomId}',       fn (User $u, string $roomId) => ...)
  Broadcast::channel('public-chat-staff.{roomId}', fn (User $u, string $roomId) => ...)
Both load the PublicChatRoom (the model carries no global scope) and reuse the workspace-membership query already written verbatim at routes/channels.php:47-52 — WorkspaceMember where workspace_id = $room->workspace_id, user_id = $u->id, status = 'active' — returning {id,username,display_name} or false. The existing room.{roomId} callback (channels.php:16-36) is NOT modified: public chat rooms are not in `rooms`, so support agents never hit the RoomMember gate that would otherwise deny them under Decision A.

VISITOR AUTHORISATION — API-215, the only genuinely new mechanism:
POST /api/v1/public-chat/{code}/broadcasting/auth (public, throttled, bearer ignored)
  1. resolve room by code; 410 if expired or soft-deleted
  2. assert $request->channel_name === 'private-public-chat.'.$room->id by STRING EQUALITY. Not a prefix match, not a regex, not str_contains — there is exactly one legal value per code. This explicitly rejects the -staff channel, which is not derivable from any visitor input.
  3. return Broadcast::driver()->validAuthenticationResponse($request, []);
     PusherBroadcaster::validAuthenticationResponse (vendor/.../PusherBroadcaster.php:104-113) short-circuits for any private-* channel and signs only "socket_id:channel_name" with the app secret — it has no User dependency. `reverb` resolves to PusherBroadcaster (BroadcastManager::createReverbDriver is literally createPusherDriver, :318-332).
PRIVATE channel, never presence: presence requires a user identifier and would hand the visitor the agent roster.
The existing Broadcast::routes(['middleware'=>['auth:api']]) at routes/api.php:30 is untouched — it cannot serve a visitor anyway, since access_tokens.user_id and sessions.user_id are both NOT NULL FKs to users.

EVENTS — all extend App\Events\RealtimeEvent, envelope {event, workspace_id, data, emitted_at}:
EVT-080 public_chat.message.created
   PublicChatMessageCreated      → private-public-chat.{rid}        public payload
   PublicChatMessageCreatedStaff → private-public-chat-staff.{rid}  internal payload
EVT-081 public_chat.room.changed (status and/or assignment)
   PublicChatRoomChanged      → private-public-chat.{rid} — {status, can_send} ONLY; the visitor never learns who is assigned or their username
   PublicChatRoomChangedStaff → private-public-chat-staff.{rid} + private-workspace.{wid} — {status, assigned_to:{id,username,display_name}, claimed_at}
EVT-082 public_chat.room.created → private-workspace.{wid} (list liveness, staff payload)
EVT-083 public_chat.message.deleted → both room channels
EVT-084 public_chat.attachment.ready → both room channels. REPLACES the user.{uploader_id} route for these attachments: app/Events/AttachmentProcessed.php channels() gains a branch returning the two room channels when public_chat_room_id is set. Without it a visitor's image or video would never emit its "processing finished" event — uploader_id is NULL, so PrivateChannel('user.') is a dead channel — and the thumbnail would appear only on reload.
EVT-085 public_chat.typing → both channels; the visitor variant carries sender_kind only, never a username.

RECONNECT CATCH-UP: GET …/messages?after_seq=<last seen>, the same discipline as the existing gap-fill branch at MessageController.php:76-84. The visitor page falls back to polling that endpoint every 5s if the socket fails to connect, mirroring PublicMeetingPage's 10s precedent.
Events dispatch AFTER commit (DB::afterCommit) so a rolled-back claim never broadcasts.

## Web UI

=== RAIL ENTRY — FR-PCHAT-003 ===
apps/web/src/components/AppShell.tsx:53, new button after Board:
  <button className={location.pathname.startsWith('/public-chat') ? 'active' : ''} aria-label="Public Chat" title="Public Chat" onClick={() => navigate('/public-chat')}><Icon name="lifebuoy" /><PublicChatBadge /></button>
TWO MANDATORY CO-EDITS:
 (a) the Conversations button's active test is a NEGATIVE-match chain (AppShell.tsx:53) — add `&& !location.pathname.startsWith('/public-chat')` or two rail items light simultaneously.
 (b) apps/web/src/components/Visual.tsx:7 — `Icon` takes name: keyof typeof paths from a CLOSED 21-key SVG map with no support/headset glyph. Add a `lifebuoy` key, or it is a TypeScript error, not a runtime fallback.
Badge = API-227 summary.new + summary.problem, polled 30s and invalidated by EVT-081/082 on private-workspace.{wid}.

=== apps/web/src/pages/PublicChatListPage.tsx — FR-PCHAT-004/005 ===
Follows the BoardPage filter pattern (pages/BoardPage.tsx:161-179), NOT RoomList.tsx — RoomList is flat, membership-scoped and unfilterable, and public chat rooms are deliberately absent from useRooms() because they are not in `rooms` at all.
  const [status,setStatus] = useState<PublicChatStatus[]>([]);
  const [assignee,setAssignee] = useState<'all'|'me'|'none'|string>('all');
  const [q,setQ] = useState(''); const [needsReply,setNeedsReply] = useState(false);
  useQuery({queryKey:['public-chat','rooms',slug,status,assignee,q,needsReply], ...})
Filter state goes into the queryKey and is serialised server-side by a new packages/api-client/src/endpoints.ts entry publicChatRooms(slug,{status,assigned,q,needs_reply,cursor}) → URLSearchParams, mirroring boardTickets (endpoints.ts:77-80). Server-side filtering, never client-side filtering of a fetched list.
Row: customer_name (bold) · provider_name (muted) · STATUS PILL · ASSIGNEE Avatar + display_name or "Unassigned" · relative last_message_at · amber dot when needs_reply.
Controls: segmented status control (All / New / In progress / Done / Problem), assignee <select> (Anyone / Me / Unassigned / each active member), text <input>, "Needs reply" toggle.

=== apps/web/src/pages/PublicChatRoomPage.tsx — FR-PCHAT-006 ===
A DEDICATED slim view. ChatView.tsx is NOT reused: it renders <CallButtons/> unconditionally, requires useSession().currentWorkspace.slug for every endpoints.*(roomId, slug) call, and pulls roomStore/sessionOutbox/ReadReceiptReporter — all `rooms`-shaped. Composer.tsx is not reused either: its draft key is orgchat.draft.${senderId}.${workspaceId}.${roomId} and its uploader is useUploader(slug) with workspace-scoped tickets.
Header: customer_name, a status <select> (API-224), an assignee <select> (API-224), and a "Claimed by X at HH:mm" line. Composer: text + attach (image/video/file), client_message_id = crypto.randomUUID(), sent via a react-query mutation with retry; no outbox in v1. Subscribes to private-public-chat-staff.{rid} via the app's existing useEcho().

=== apps/web/src/pages/PublicChatVisitorPage.tsx — FR-PCHAT-007 ===
Route /support/:code declared in apps/web/src/App.tsx:51 as a SIBLING of /meet/:code, at the top level OUTSIDE both <EchoProvider> and <CallProvider> (App.tsx:52-55). That placement is what structurally guarantees "no call, no meeting" on the client — CallButtons cannot mount even by mistake.
Reuses from PublicMeetingPage.tsx: the /^[a-f0-9]{64}$/ pre-fetch code check, the try/catch sessionStorage helpers, the ApiError.status → human sentence mapper (404/410/409/429), useQuery({retry:false}), the <Banana/> wordmark, and the bc-public-* CSS in pages/meetings.css.
Builds its OWN Echo instance with an authorizer that POSTs to API-215 — EchoProvider.tsx:62-77 is hardwired to tokenManager.getAccessToken() and gated on status==='authenticated', so it cannot be reused. Falls back to ?after_seq= polling at 5s if the socket fails.
Composer offers text + attach only. No call button exists in the tree.
i18n: this is the FIRST apps/web consumer of packages/shared/src/i18n.ts createTranslator, driven by room.locale (default 'th' per FR-I18N-001). Every other web surface is hardcoded English; a Thai end-customer page must not inherit that by default. New keys under pchat.*.

=== packages/chat-core/src/public-chat.ts — FR-PCHAT-008 (CLAUDE.md: never in apps/) ===
Modelled on secret-room.ts; Vitest suite public-chat.test.ts; exported from index.ts.
  export const PUBLIC_CHAT_STATUSES = ['new','in_progress','done','problem'] as const;
  export type PublicChatStatus = typeof PUBLIC_CHAT_STATUSES[number];
  export interface PublicChatRoomLike { status; assigned_to; last_visitor_seq; last_agent_seq; customer_name; provider_name; last_message_at }
  publicChatStatusLabel(status, locale) · publicChatStatusTone(status): 'neutral'|'info'|'ok'|'warn'
  needsReply(room) => last_visitor_seq > last_agent_seq && status !== 'done'
  filterPublicChatRooms(rooms, {status, assignee, q, needsReply, meId})
  agentExternalName(provider, username) => `${provider} (${username})` — ONE definition shared by the server test fixtures and both clients so the format cannot drift
  isPublicChatCode(s) => /^[a-f0-9]{64}$/.test(s)
  visitorDisplayName(name) => trimmed, 1..120, control chars stripped
  publicChatLinkPath(code) => `/support/${code}`
packages/shared/src/types.ts: add PublicChatStatus, PublicChatRoom, PublicChatMessage, PublicChatMessageKind + matching zod schemas. Do NOT touch the existing `export type RoomType = 'dm'|'group'|'channel'` (types.ts:9) — this design adds no room type, so the existing PHP(dm|group)/TS(dm|group|channel) drift is neither widened nor inherited.

## Admin UI (Filament 3.3)

Filament is v3.3.55 (composer.lock:1373, PRODUCT_SPEC.md:139) — the brief's "v4" is wrong. v3 idioms throughout: Filament\Forms\Form + ->schema() (no Filament\Schemas\Schema), ->actions([...]) not ->recordActions([...]), and the two same-named classes kept straight — Filament\Tables\Actions\Action for ROW actions, Filament\Actions\Action for List-page HEADER actions. BadgeColumn is deprecated in 3.3; use TextColumn::make('status')->badge()->color(fn ($state) => ...).

=== app/Filament/Resources/PublicChatRoomResource.php — FR-PCHAT-021 ===
extends App\Filament\Resources\BrowseResource (canCreate/canEdit/canDelete/canDeleteAny all false — FR-ADM-007/012, browse + explicit audited actions only). $navigationGroup = 'Content' — one of the four names already in AdminPanelProvider::navigationGroups (app/Providers/Filament/AdminPanelProvider.php:41-43); a new name would render ungrouped at the bottom.
Query: ->withoutGlobalScopes() for the cross-workspace admin view.
Columns: workspace.name · customer_name · provider_name · status TextColumn->badge() (new=gray, in_progress=info, done=success, problem=danger) · assignedTo.display_name placeholder 'Unassigned' · last_message_at · created_at.
Filters: SelectFilter::make('status') with the four options · SelectFilter::make('workspace_id') · TernaryFilter::make('assigned') · a date-range Filter on last_message_at.
Row action 'transcript' — audits FIRST:
  app(ModerationService::class)->audit(auth('admin')->user(), 'public_chat.transcript_viewed', $record)
  then ->modalContent(fn ($r) => view('filament.admin.public-chat-transcript', [...]))->modalSubmitAction(false)->modalWidth('4xl')
  NEW blade apps/api/resources/views/filament/admin/public-chat-transcript.blade.php renders sender_kind, the external display name, body and attachment names. All customer-supplied strings through {{ }}, never {!! !!}.
Row action 'export' — streamed CSV + JSON like RoomResource's, reusing its =+@-\t\r CSV-injection prefix guard. Columns include sender_kind, external_display_name, agent_username_snapshot and customer_name, closing a real gap: RoomResource's exports emit sender_id only, which for a NULL-sender support transcript would make visitor identity absent entirely.
->bulkActions([]) — no mass moderation, consistent with the rest of the panel.
RoomResource and MessageResource are NOT modified. Public chat rooms are not in `rooms`, so RoomResource's hardcoded ['dm'=>'Direct','group'=>'Group'] type filter stays correct, and MessageResource's ->placeholder('System / AI') never mislabels a visitor message — which it would have done for every NULL-sender row had this shared the `messages` table.

=== app/Filament/Resources/PublicChatApiKeyResource.php — FR-PCHAT-030/032 ===
extends BrowseResource. $navigationGroup = 'System'.
Columns: workspace.name · name · key_id (copyable) · '****'.secret_last4 · last_used_at · revoked_at as a badge ('Active'/'Revoked').
ISSUANCE is a List-page HEADER action, NOT a CreateAction — BrowseResource::canCreate() returns false and CreateAction authorises against it, so a CreateAction would silently never render. In app/Filament/Resources/PublicChatApiKeyResource/Pages/ListPublicChatApiKeys.php:
  protected function getHeaderActions(): array {
    return [ \Filament\Actions\Action::make('issue')->label('ออก API key')
      ->form([Select::make('workspace_id')->options(...)->required(), TextInput::make('name')->required()->maxLength(80)])
      ->action(function (array $data) {
          $r = app(PublicChatApiKeyService::class)->issue($data['workspace_id'], $data['name'], auth('admin')->user()); // audits 'public_chat.api_key_issued'
          Notification::make('pchat_secret')
            ->title('บันทึก secret นี้ทันที — จะไม่แสดงอีก')
            ->body($r['key_id'].PHP_EOL.$r['secret'])
            ->persistent()->success()->send();
      }) ];
  }
ListRecords registers NO header actions by default — omitting this override ships an empty state with no button, the bug already recorded at UserResource.php:112-115 / ListAiProviders. ->persistent() is what keeps the secret on screen until dismissed (the temp-password precedent at UserResource.php:127-132).
Row action 'revoke' — requires confirmation, sets revoked_at = now(), audits 'public_chat.api_key_revoked'. Row action 'rotate' = revoke + issue, one new secret notification.
REVOCATION SEMANTICS — FR-PCHAT-032: every subsequent HMAC call with that key_id gets 401 API_KEY_INVALID at verification step 3. Rooms the key already created STAY OPEN and their links keep working. A key is an integration credential, not the owner of customer conversations; killing live customer chats because an ops key rotated would be a worse failure than the one revocation is meant to prevent. (This is also why M2's create-idempotency unique excludes api_key_id.)

=== SETTINGS — FR-PCHAT-033/034 ===
app/Services/SettingsService.php DEFAULTS gains three keys:
  'publicchat.enabled' => false,            // bool → auto-renders a Toggle
  'publicchat.link_ttl_days' => 30,         // int
  'publicchat.max_message_length' => 4000   // int
Section title is ucfirst(explode('.', $key)[0]) → "Publicchat". Ships OFF by default so enabling is a deliberate admin act.
app/Filament/Pages/Settings.php ranges() MUST also gain:
  'publicchat.link_ttl_days' => [1, 365], 'publicchat.max_message_length' => [1, 32000]
— Settings::form() does [$min,$max] = self::ranges()[$key] with NO guard, so an int key added to DEFAULTS without a ranges() entry throws on the settings page for every admin.
Settings::HELPERS gains a policy note on publicchat.enabled citing FR-PCHAT-034 / DEC-067 (the FR-CALL-006 / DEC-057 entry is the worked example).
Every admin surface uses the `admin` guard (auth('admin')), never the default guard, and routes through ModerationService, which re-checks is_system_admin + status Active on each call.

## Security / threat model

LINK GUESSING — 256 bits from random_bytes(32). Routes are constrained ->where('code','[a-f0-9]{64}') so malformed codes 404 at routing before touching the DB, and pchat-visitor-read is keyed BY CODE so enumeration cannot be amortised across codes. Not brute-forceable.

KEY LEAKAGE — key_id is public and safe in logs; the secret appears exactly once, in a Filament notification, and never again in any response, log, export or form (model $hidden). Compromise is contained by revoke/rotate (FR-PCHAT-032), bounded for captured requests by the ±300s skew window, and made non-replayable by the nonce cache. Residual, stated plainly: a DB dump AND APP_KEY together yield the secret (DEC-062).

VISITOR IMPERSONATION — possession of the code IS the identity, by design (DEC-063). A visitor cannot forge an agent message: sender_kind is set server-side from the authenticated tier, never from the payload, and Tier 2 has no code path that can write sender_kind='agent'. Conversely an agent cannot be impersonated on the visitor channel because API-215 can only ever authorise private-public-chat.{own room id}.

CROSS-WORKSPACE LEAKAGE — five independent layers, any one sufficient:
 1. STRUCTURAL: there is no query path from public_chat_* to `rooms` or `messages` at all, so no public-chat bug can surface an internal room or message.
 2. The public-chat models carry NO WorkspaceScope global scope, so the silent-no-op failure mode is removed — WorkspaceScope.php:20 returns EVERY workspace's rows when context is unset, with no error, which on an unauthenticated route is a cross-tenant leak that looks like working code.
 3. Every Tier-2 query resolves the room by code first and filters workspace_id explicitly.
 4. public_chat_messages.workspace_id is denormalised: even a wrong room_id join cannot cross tenants because workspace_id is also in the WHERE.
 5. The HMAC middleware sets WorkspaceContext from the key before the controller runs; Tier 3 gets its workspace from workspace.context, which already proves active membership.

XSS IN CUSTOMER-SUPPLIED NAMES — customer_name, provider_name, external_ref and meta are attacker-controlled from the customer's own site and render on three surfaces (visitor page, agent UI, Filament transcript). Rules:
 - Ingest: max 120 chars, strip C0/C1 control chars and U+200B–U+200F / U+202A–U+202E, reject if empty after trim. chat-core visitorDisplayName is the single definition.
 - React: plain {name} interpolation only; never dangerouslySetInnerHTML.
 - Markdown: parseMarkdown applies to message BODY only, NEVER to names. The `provider (username)` string is assembled and rendered as plain text.
 - Filament blade: {{ }} only in public-chat-transcript.blade.php, never {!! !!}.
 - CSV export: the =+@-\t\r prefix guard from RoomResource applied to EVERY customer-supplied column, not just body.
 - meta jsonb is NEVER serialised to the visitor and renders in admin as <pre>{{ json }}</pre>.

FILE / VIDEO UPLOAD ABUSE — kind restricted to image|video|file at the Tier-2 request layer ('avatar' rejected 422 before UploadService is called, and claimAttachments rejects AttachmentKind::Avatar anyway); UploadService::assertMimeMatchesKind:196 sniffs the real mime; the blocked-extension deny list and per-kind caps (20MB/200MB/100MB) apply unchanged; pchat-visitor-upload caps 10 tickets/min/code; message.max_attachments caps 10 per message. An attachment with public_chat_room_id set can ONLY be claimed by a message in that same room and can NEVER be claimed by an internal message. That partition has two enforcement layers: the explicit ->whereNull('public_chat_room_id') added to MessageWriter::claimAttachments, and the fact that MessageWriter.php:175, RoomToolsController.php:56 and BoardService.php:122 all test `uploader_id === $actor->id`, which a NULL uploader_id can never satisfy — so the internal claim paths are naturally fail-closed against visitor uploads even if the explicit guard were removed.
Serving is safe without a bearer: AttachmentSerializer emits only signed 60-minute temporary GET URLs and (verified) does NOT emit uploader_id. Even so, PublicChatPublicSerializer::attachment() WHITELISTS {id,kind,status,original_name,mime_type,size_bytes,width,height,duration_ms,urls,urls_expire_at} rather than delegating, so a field added to AttachmentSerializer in future cannot reach the customer.

DoS — named limiters keyed by code (visitor) and key_id (customer) rather than IP, so one noisy visitor cannot exhaust another's budget and the customer's single server IP is not the key. The nginx edge zone (prod.conf:12, 300r/m burst=150 per source IP) remains a real ceiling for a busy customer — see R3.

CAPABILITY-URL HYGIENE — infra/nginx/prod.conf gains a /support/ location block copied verbatim from the /meet/ block (prod.conf:62-70): Referrer-Policy: no-referrer, Cache-Control: no-store, access_log off. The URL IS the credential, so it must not leak via referrer header, proxy cache or access log. The code never appears in a query string, only in the path.

AUDIT — every admin action goes through ModerationService::audit (which re-checks is_system_admin + status Active per call); every assignment, status change, key issuance/revocation and message deletion is written via Services/AuditLogger.

TESTS (TC-PCHAT-001..031): 001 HMAC happy path returns a /support/<64hex> link · 002 one-byte body tamper → 401 API_SIGNATURE_INVALID · 003 301s-old timestamp → 401 API_TIMESTAMP_SKEW · 004 nonce replayed inside 300s → 409 · 005 revoked key → 401, its rooms still reachable · 006 same external_ref twice → 200 same code, one row · 007 re-serialised key-reordered body → 401 (documents the raw-bytes rule) · 008 valid sig + feature off → 503 not 401 · 009 visitor POST twice with one client_message_id → one row, 201 then 200 · 010 two concurrent agent replies → exactly one claim, one system row, gapless seq · 011 auto-claim sets status/assigned_to/claimed_at and emits EVT-081 · 012 reassignment and all four status transitions persist · 013 agent message renders externally as "Provider (username)", internally as the user · 014 public payload contains no user ULID, no mentions, no reply_to, no room.meta · 015 later username change leaves old messages on the snapshot · 016 visitor auth for own channel succeeds · 017 visitor auth for another room's channel → 403 · 018 visitor auth for private-public-chat-staff.{own id} → 403 · 019 active member authorises both channels, suspended member and other-workspace member refused · 020 visitor uploads image/video/file, 'avatar' → 422 · 021 a public-chat attachment cannot be claimed by an internal message · 022 an internal attachment cannot be claimed by a public-chat message · 023 visitor attachment ready emits EVT-084 on the room channels, not user.{null} · 024 POST /rooms/{public_chat_room_id}/calls → 404 · 025 public chat rooms never appear in GET /rooms, search, or workspace unread · 026 feature off: writes 503, visitor GET 200 can_send:false, admin transcript 200, state preserved across a disable/enable cycle · 027 link opened in two browsers: both send and receive · 028 after done: visitor GET 200 read-only, POST 409, agent reopen → POST 201 · 029 after expires_at every Tier-2 route incl. broadcasting/auth → 410 · 030 '<img src=x onerror=alert(1)>' as customer_name renders as text on all three surfaces and '=cmd' is quoted in CSV · 031 a code from workspace A is unreadable with X-Workspace-Id B and no Tier-2 response returns another workspace's rows. TC-PCHAT-017/018 and 021/022 are SECURITY tests, not integration tests. chat-core public-chat.test.ts covers needsReply, filterPublicChatRooms, agentExternalName, isPublicChatCode and visitorDisplayName control-char stripping.

## Trade-offs

WHAT THE DUPLICATION BUYS. This feature edits 16 existing files and none of them is a room or message read path. RoomController::index, SearchController::memberRoomIds, CallService::allowed, the room.{roomId} channel callback, RoomPolicy, MessageEditor, Jobs/NotifyMessage, workspaceUnread, GenerateRoomBotReply and the RoomType enum are all untouched — every one of which a shared-table design would have had to teach about a new room type independently, across five separate membership gates, with a silent leak as the failure mode for each. Three specific bug classes are eliminated by construction rather than by a gate someone must remember: visitor messages cannot appear in GET /rooms or search, no call surface exists to forget to block, and nobody is left unable to delete a visitor message.

WHAT IT COSTS, honestly:
1. A SECOND MESSAGE WRITE PIPELINE. PublicChatMessageWriter re-implements the lockForUpdate / last_seq+1 / idempotency-lookup / attachment-claim discipline. A bug fixed in MessageWriter is not automatically fixed here. Mitigated by keeping the method bodies deliberately structurally identical and by TC-PCHAT-010's gapless-seq assertion.
2. A SECOND SERIALIZER, intentionally with NO SHARED BASE CLASS. Two places to add a field — which is the point, since a shared base is precisely how a field added for staff leaks to the customer — but it is still two places.
3. NO PER-AGENT UNREAD. There are no room_members rows, so there is no last_read_seq per agent. v1 substitutes needs_reply (last_visitor_seq > last_agent_seq) plus a rail badge counting new+problem rooms. An agent cannot see "3 unread in this room"; they see "this room is waiting on us". For a shared support queue that is arguably the more useful signal, but it is strictly less information and should be named as a gap, not sold as a feature.
4. NO REUSE OF ChatView / Composer / RoomList on the web — three new components. The alternative was gating CallButtons and threading nullable workspace props through a component used by every internal room: more invasive, and a gate that can be forgotten.
5. NO REUSE OF RoomResource / MessageResource in admin — two new Filament resources.
6. A SECOND BROADCASTING-AUTH PATH. Small, but it is new security-relevant code with no existing precedent in this repo.

ALTERNATIVES CONSIDERED AND REJECTED:
• rooms.type='support' with lazy room_members materialisation — rejected: five independent membership gates each needing a branch; MessageWriter::fanOut going O(N) broadcasts plus N aggregate queries per visitor message; visitor messages silently producing zero push (NotifyMessage.php:56-59 early-returns on a null sender, with no exception and no log); nobody able to delete a visitor message (MessageEditor.php:134-148); and support rooms leaking into GET /rooms, search and the workspace badge unless every one of those is excluded. Each is individually fixable; the aggregate is exactly the class of bug this feature must not have.
• A per-device visitor token layered on the code — rejected for v1: it breaks the forwarded-link flow the customer controls and adds a second credential to leak, for a threat (link sharing) that expiry plus referrer/cache hygiene already bounds. Revisit if a customer asks.
• Auto-reopening a 'done' room on a visitor message — rejected (DEC-069): a stale link could resurrect a closed ticket with no agent seeing it.
• Duplicating the media pipeline for full isolation — rejected (DEC-068): two copies of mime sniffing, extension blocking and size caps WILL drift, and drift in a security check is worse than one nullable partition column with fail-closed guards on both claim paths. This is the one duplication the isolation angle explicitly declines, and the reason is that the shared code is the security code.

FEATURE-OFF BEHAVIOUR (DEC-067), stated as a tradeoff because it is a deliberate asymmetry: writes stop, reads and data survive. Tier 1 create/close → 503 PCHAT_DISABLED with Retry-After: 60, AFTER signature verification so the customer can distinguish "your key is bad" from "the service is paused"; API-201 read still answers. Tier 2 visitor GET → 200 with feature_enabled:false, can_send:false — deliberately not 503, so the page shows a calm "support is temporarily unavailable" banner with the existing transcript still readable instead of an error page; visitor POST → 503. Tier 3 agent writes (send, status, assignment, upload, delete) → 503; agent reads unaffected, rail entry stays visible with a "paused" chip. Filament admin fully unaffected — transcripts are records, and an admin must be able to read what happened precisely when the feature is switched off. Existing open conversations are not closed, expired, reassigned or deleted: status, assigned_to and every message are preserved exactly, and re-enabling resumes mid-conversation with no migration. In-flight calls that passed the gate complete normally — the gate is checked once, before a short write transaction, so there is no mid-transaction abort and no partial write. Propagation is immediate cluster-wide because Settings::save() calls $settings->flush(), forgetting the shared Redis key app_settings:all; the SettingsService::CACHE_TTL=60 window applies only if app_settings is mutated outside the admin page. Open sockets stay subscribed and are not force-disconnected — they simply receive nothing, because nothing is written, so no new disconnect mechanism is needed.

LINK LIFECYCLE (DEC-063/069). Opened twice or on two devices: both work, both live, both may send, both see full history — accepted and intended, since the customer's end user may switch desktop to phone, and the meeting feature sets the precedent; the consequence is that there is no way to tell two tabs apart and no "link already in use" error. Shared or forwarded: full access transfers, bounded by expires_at (publicchat.link_ttl_days, default 30 → 410 PCHAT_LINK_EXPIRED) and the nginx no-referrer/no-store/access_log-off block. After 'done': GET returns 200 read-only with full history — a closed conversation that 404s is a support-quality regression and the customer keeps their receipt — while POST returns 409 PCHAT_ROOM_CLOSED; any agent may PATCH back to in_progress, re-enabling visitor sending immediately via EVT-081. After expiry or soft-delete every Tier-2 route including broadcasting/auth returns 410, so an open socket cannot outlive the link.

## Risks stated by the author

- R1 DECISION C IS AMENDED, NOT IMPLEMENTED AS WRITTEN (DEC-062). The API secret is APP_KEY-encrypted via Crypt::encryptString, not hashed, because HMAC verification must recompute the MAC with the key material and a digest cannot supply one — 'HMAC-signed' and 'stored hashed' are mutually exclusive. The user-visible property (shown once, never retrievable afterwards) is fully preserved. If a reviewer insists on a true digest at rest, the auth scheme must change from HMAC to a presented-bearer-secret compared by hash — a different and weaker design, since the secret then travels on every request. Decide before implementation starts; nothing else in this design depends on the outcome.
- R2 NO MOBILE PUSH TO AGENTS. Visitor messages never enter Jobs/NotifyMessage, so there is no push notification for a new customer message. In-app realtime covers an agent with the web app open; an agent with the app closed learns nothing. This is a real product gap, not an oversight (OQ-PCHAT-002). If push is required at launch, a PublicChatNotify job reusing PushDecisionService is roughly a day's work and must NOT reuse NotifyMessage, whose first act is to early-return on a null sender.
- R3 EDGE RATE LIMIT vs A SINGLE CUSTOMER IP. nginx limit_req_zone edge_api is 300r/m burst=150 keyed on $binary_remote_addr (prod.conf:12,106). The customer calls from one server IP, so app-level per-key limiters cannot raise that ceiling and a busy integration will see 503s from nginx that look like our app failing. Size capacity against it, or ship OQ-PCHAT-003's X-PChat-Key-keyed exemption with the feature. Note also that the RateLimiter::for('api') limiter is defined but never applied anywhere, so nginx is the only backstop.
- R4 THE LINK IS BEARER AUTHORITY. Anyone holding the URL is the visitor; there is no device binding in v1 (DEC-063). Expiry, no-referrer and no-store bound the exposure, but nothing prevents a forwarded link from being used. This must be stated prominently in the customer-facing integration docs, not buried.
- R5 TWO SPEC NON-GOALS ARE OVERRIDDEN. NG5 (guest / external user across workspace) and NG6 (bot / webhook / integration API) both explicitly exclude this feature today (PRODUCT_SPEC.md:62-63), and Appendix C's parking lot lists both 'Guest access' and 'Bots/Webhooks'. DEC-060 and DEC-061 plus a §16 changelog row removing those entries must land BEFORE any FR-PCHAT-* is written, or the spec contradicts itself — and CLAUDE.md forbids changing specced behaviour without exactly that.
- R6 THE ATTACHMENT PARTITION IS THE SINGLE SHARED SURFACE AND THEREFORE THE SINGLE POINT OF FAILURE (DEC-068). If ->whereNull('public_chat_room_id') is ever dropped from MessageWriter::claimAttachments, a visitor-uploaded file becomes claimable by an internal message. The natural fail-closed behaviour of the `uploader_id === $actor->id` tests provides a second layer, but TC-PCHAT-021/022 must both exist and must be treated as security tests.
- R7 DRIFT BETWEEN THE TWO WRITE PIPELINES over time, as MessageWriter gains fixes that PublicChatMessageWriter does not. This is the accepted cost of the isolation angle. Budget a periodic diff review; there is no automated guard.
- R8 THE VISITOR BROADCASTING-AUTH ENDPOINT IS NEW SECURITY CODE WITH NO IN-REPO PRECEDENT. validAuthenticationResponse($request, []) without a user is correct per PusherBroadcaster.php:104-113 but is exercised nowhere today. The string-equality channel assertion is the ONLY thing standing between a visitor and every other room's channel — Reverb's allowed_origins is ['*'] (config/reverb.php:85) and CORS is framework-default wide open with no config/cors.php, so neither is a backstop. TC-PCHAT-017/018 are mandatory.
- R9 i18n IS UNWIRED ON WEB. Nothing under apps/web/src imports packages/shared createTranslator today (only apps/mobile does); the visitor page would be the first consumer. If that wiring is deferred, the customer-facing page ships hardcoded English to a product whose default locale is 'th'. This is also why system messages carry system_event + system_meta instead of a baked-in body string.
- R10 FILAMENT VERSION CORRECTION. The brief said v4; the repo is v3.3.55 (composer.lock:1373, PRODUCT_SPEC.md:139). Every admin detail in this design is v3. A v4-shaped implementation (Filament\Schemas\Schema, unified Filament\Actions\*, ->recordActions()) will not compile. Related v3 traps already recorded in-repo: ListRecords registers no header actions by default, and BrowseResource::canCreate() being false means key issuance must be a header Action, not a CreateAction.
- R11 SETTINGS PAGE BREAKS IF ranges() IS MISSED. Settings::form() does [$min,$max] = self::ranges()[$key] with no guard, so adding publicchat.link_ttl_days / publicchat.max_message_length to SettingsService::DEFAULTS without matching Settings::ranges() entries throws on the settings page for every admin — a self-inflicted outage of the very page that turns the feature off.


## MANDATORY grafts from the rejected designs (judges)

1. FROM D3 — the `status_public` projection. D2's API-210 returns raw `status` and EVT-081 sends `{status, can_send}` to `private-public-chat.{rid}`, so a customer learns an agent flagged their conversation `problem`. Project to `open` (new|in_progress|problem) / `closed` (done) on every visitor surface, exactly as D3 specifies. D1 has the identical leak.

2. FROM D3 — message-body search in the agent queue. D2's API-220 `q` is ILIKE over customer_name/provider_name/external_ref only. The requirement says 'all support can see all room + message'; finding a room by what the customer actually said needs D3's `messages.body` EXISTS subquery (here, over `public_chat_messages`). D1 has the same gap.

3. FROM D3 — the push design, which closes D2's admitted R2 ('no mobile push to agents'). D3 §11 fully specifies it: a NEW job (never reuse `Jobs/NotifyMessage`, verified to early-return on a null sender at lines 56-59), pushing to `assigned_to` when set and deliberately to NOBODY when unassigned, relying on the queue badge instead of waking every workspace member, with `customer_name` supplied as the display name because `PushDecisionService` dereferences `$sender->display_name`. This is a day of work, not an open question.

4. FROM D3 — reply/quote in `public_chat_messages`. D2 omits `reply_to_message_id` entirely and TC-PCHAT-014 asserts its absence. NG4 defines this product's chat as inline reply/quote; a support agent quoting which of three questions they are answering is basic. Add the column and a snippet-only `reply_to` to the public payload (no `sender_id` — that is the leak D2 rightly designs against).

5. FROM D3 — API-203 `rotate-link`. D2's only remedy for a leaked capability URL is closing the room, which also ends the conversation. Minting a new `code` kills the old link instantly while the conversation continues. Cheap, and it is the entire answer to D2's own R4.

6. FROM D1 — `access_log off` on the API path. D2's nginx hygiene block covers only `/support/` (the SPA), but its visitor API is `/api/v1/public-chat/{code}/messages`, so nginx logs the live credential verbatim on every request. D1 is the only design that names this. Add `location ^~ /api/v1/public-chat/ { access_log off; }` alongside the `/support/` block. (The same gap exists today on `/public-meetings/{code}` — fixing one and not the other leaves a known hole open.)

7. FROM D3 — throttle the `last_used_at` write. D2 does `$key->forceFill(['last_used_at'=>now()])->saveQuietly()` on every partner request, i.e. one UPDATE per API call. D3 writes at most once a minute (`if ($key->last_used_at?->lt(now()->subMinute()) ?? true)`). Same operator value, none of the write amplification.

8. FROM D3 — `DecryptException` handling in the HMAC middleware. After an APP_KEY rotation `Crypt::decryptString($key->secret_ciphertext)` throws; D2's step 4 has no try/catch, so a rotation turns every partner request into a 500 with a stack trace. D3 catches it, returns `API_KEY_INVALID` 401, and `Log::critical`s. Also graft D3's APP_KEY-rotation runbook note: every partner key must be reissued, because decryption will fail for all of them.

9. FROM D3 — the `pcs_` secret prefix. D2's secret is `'pcs_' + bin2hex(...)` already; keep D3's stated reason in the docs, that `pcs_[0-9a-f]{64}` is a shape GitHub/gitleaks can pattern-match, so a secret committed to the customer's public repo is caught.

10. FROM D1 and D3 — the explicit 'server-side only, never from browser JS' warning, printed in the Filament issuance notification itself and not only in the docs. The natural integrator mistake is to sign from the storefront's front end, which ships the secret to every visitor, and no CORS setting can prevent it.

11. SPECIFY, because D2 leaves it open — `public_chat_messages.client_message_id` is NOT NULL, but system rows (`sender_kind='system'`, `system_event`) have no client. Say explicitly that the server generates a ULID for them, or the first status change violates the constraint.

12. PARTNER API MUST ADDRESS ROOMS BY ULID, NOT BY {code} (from Designs 1 and 3). Design 2's API-201/202 are GET/POST /api/v1/partner/public-chat/rooms/{code} with ->where('code','[a-f0-9]{64}'). That sends the visitor's bearer credential on every partner status poll — into the partner's outbound HTTP logs, any intermediate proxy, and our own nginx access log, which Design 2's /support/ access_log-off block does not cover. Designs 1 and 3 both address partner rooms by the room ULID returned at create. Adopt that, and additionally add 'access_log off' to a location block for /api/v1/public-chat/ (Design 1 explicitly flags that the API path carries the code and nginx logs it verbatim — a gap the existing /public-meetings routes share).

13. FIX THE VISITOR/AGENT IDEMPOTENCY KEY COLLISION (structure from Designs 1 and 3). Design 2's UNIQUE(room_id, client_message_id) spans both visitor and agent rows while accepting a free-form varchar(64) 'client_message_id 1..64' from the visitor. A visitor can squat values, and a collision with an agent's client id silently returns the visitor's message to the agent as a 200 replay. Designs 1 and 3 avoid this structurally with a partial index scoped to sender_id IS NULL. Either add sender_kind to the unique, or constrain the visitor-supplied id to a UUID and namespace it.

14. KEEP WorkspaceScope ON THE NEW MODELS (correcting Design 2's own reasoning). Design 2 removes the global scope claiming it 'turns a forgotten filter into a visible bug.' It does not — a forgotten ->where('workspace_id') on the unauthenticated Tier 2 leaks identically with or without the scope; only a test makes it visible. Meanwhile on Tier 3, where workspace.context IS set, the scope would have protected PublicChatRoom::find($id). Keep the scope (inert on Tier 2 anyway, protective on Tier 3), keep the explicit Tier-2 wheres and the denormalised workspace_id, and make TC-PCHAT-031 assert every Tier-3 endpoint 404s for another workspace's room.

15. PER-AGENT READ POINTER (the honest gap Design 2 names in its own tradeoffs #3, solved by Designs 1 and 3). Design 2 substitutes needs_reply (last_visitor_seq > last_agent_seq) because it has no room_members rows. That is strictly less information — an agent cannot see 'I have 3 unread here.' Add a small public_chat_reads(room_id, user_id, last_read_seq) table; it is far cheaper than Design 1's lazy room_members materialisation and carries none of that design's fan-out cost.

16. ROTATE-LINK (Design 3, API-203). This is the only remedy for a leaked capability URL short of closing the conversation, and Design 2 has nothing between 'expires in 30 days' and 'close the room.' Mint a new code, old code 404s immediately. Given that both designs concede the link is unrevocable bearer authority, this is the one control that makes the concession survivable.

17. ATTACHMENTS CHECK CONSTRAINT (Design 3, migration 3): ALTER TABLE attachments ADD CONSTRAINT attachments_owner_chk CHECK (uploader_id IS NOT NULL OR public_chat_room_id IS NOT NULL). Design 2 drops NOT NULL on uploader_id and relies on application-level partitioning only. The CHECK makes an attachment owned by nobody unrepresentable at the database level — the cheapest possible backstop on the one surface Design 2 admits is its single point of failure (its R6).

18. AGENT-OPENS-THE-LINK: DISABLE THE COMPOSER, DON'T REPURPOSE IT (Design 1, DEC-063). Designs 2 and 3 both ignore the bearer and silently treat a signed-in agent as the visitor. ApiClient.doRequest attaches the agent's token to every request, so an agent opening a customer link to check on it posts a message recorded as coming from the customer. Design 1 detects the valid member bearer and replaces the composer with 'You are signed in as X — open this in Public Chat'. Reads are fine to serve as the visitor; writes must not be.

19. QUEUE SORT: problem → unread → recency (Design 3). Design 2 orders by last_message_at DESC NULLS LAST, which buries a flagged or unanswered conversation under a chatty resolved one. Design 3 specifies the triage order explicitly and is right that it does the work a priority field would otherwise need.

20. PUSH NOTIFICATIONS FOR VISITOR MESSAGES (Design 3 §11; Design 2 concedes this entirely in R2). Design 2 ships with no agent push at all. Adopt Design 3's rule: push to assigned_to when the room is assigned; when unassigned, deliberately notify nobody and rely on the queue badge rather than waking every workspace member. Build it as a new job — never reuse Jobs/NotifyMessage, whose first act is a silent early-return on a null sender.

21. first_response_at COLUMN (Design 1's support_rooms). One timestamp stamped by the same auto-claim UPDATE yields a free first-response-time metric, which is the number any support operation is judged on. Design 2 tracks claimed_at only.

22. FROM DESIGN 2 — the UploadService fix, stated as new methods rather than reuse. Design 1 says API-206/207 are 'byte-for-byte the API-060/061 flow, reusing UploadService::create() and ::complete()'. Both take a non-nullable User: `public function create(User $uploader, string $workspaceId, array $input)` (UploadService.php:39) and `public function complete(Attachment $attachment, User $uploader, ?array $parts = null)` whose first statement is `if ($attachment->uploader_id !== $uploader->id)` (lines 119-121). A visitor has no User, so as written the visitor upload path does not compile. Graft Design 2's shape: add sibling `createForPublicChat(SupportRoom $room, array $input)` and `completeForPublicChat(Attachment $a, SupportRoom $room)` that assert `public_chat_room_id === $room->id` instead of uploader identity, and do NOT widen the existing signatures across all callers.

23. FROM DESIGN 3 — key the visitor broadcast channel by room_id, not by the code. Design 1's `private-support.{code}` embeds the 64-hex capability in the channel name, which travels in the WebSocket subscribe frame, Reverb server logs, browser devtools and any Echo debug output — the same class of leak Design 1 itself flags for the nginx access log. Design 3's `private-pchat.{room_id}` leaks nothing; the auth endpoint already has `$support->room_id` in hand, so the literal string-equality assertion is unchanged in strength.

24. FROM DESIGN 3 — API-203 `POST /partner/public-chats/{roomId}/rotate-link`. Design 1's only remedy for a leaked link is API-202 close, which also ends the conversation. Rotate mints a new code, 404s the old one immediately, and lets the customer keep the conversation alive. Design 1's own security section concedes the URL is fully bearer with 'no revocation short of closing the room' — this closes that. Return the new url in the response, and note in the docs that the partner must re-deliver it (a rotate the partner cannot observe is useless).

25. FROM DESIGN 3 — the attachments CHECK constraint `CHECK (uploader_id IS NOT NULL OR public_chat_room_id IS NOT NULL)`. Design 1 states the same invariant ('exactly one of uploader_id / support_room_id is non-null') but enforces it only in application code inside UploadService. Once uploader_id becomes nullable on a hot table, a DB-level constraint is what stops an orphan attachment owned by nobody from being created by any future code path.

26. FROM DESIGN 3 — make `client_message_id` REQUIRED on the visitor send endpoint (API-205), server-side, explicitly ('unlike the member endpoint, where it is optional'). Design 1 adds the partial unique index `messages(room_id, client_message_id) WHERE sender_id IS NULL AND client_message_id IS NOT NULL` but never makes the field mandatory, so a visitor client that omits it gets zero idempotency and the index it justified at length does nothing.

27. FROM DESIGN 3 — `PublicChatApiKeyResource extends Resource`, not BrowseResource. Design 1 has `WorkspaceApiKeyResource extends BrowseResource` while its whole purpose is issue+revoke. The table header CreateAction does render (verified: vendor/filament/tables/src/Actions/CreateAction.php::setUp() has no authorize() call; only ListRecords.php:112 authorizes against canCreate()), so this is not a bug — but it contradicts BrowseResource's documented contract ('browse and explicit actions only; no accidental raw CRUD') and the in-repo proven shape is UserResource.php:27 `class UserResource extends Resource` with a table headerActions CreateAction using ->using(). Follow that.

28. FROM DESIGN 2 — a state-consistency guard on the status/assignment PATCH. Design 1's API-210 accepts `{status}` and/or `{assigned_user_id}` with no invariant, so any member can set `assigned_user_id: null` while status stays 'in_progress', or set status 'new' with an assignee still attached, and the list's 'which admin is taking that room' column goes incoherent. Graft Design 2's minimal `PCHAT_INVALID_TRANSITION` 422: a room cannot leave 'new' with a null assignee, and cannot be unassigned while in 'in_progress'.

29. FROM DESIGN 1's OWN TEXT but omitted from its migration — include `workspace_id` in the lazy `RoomMember::firstOrCreate`. `room_members.workspace_id` is `foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete()` — NOT NULL (verified in 2026_09_07_000004_create_rooms_table.php). Design 3 spells the full field list (`['role'=>'member','workspace_id'=>…,'last_read_seq'=>0]`); Design 1's RoomPolicy branch says only `firstOrCreate a role='member' row`. Also decide whether `rooms.member_count` is bumped (it is not read by anything on this path, so 'no' is fine — but say so).

30. FROM DESIGN 2 — denormalise `workspace_id` onto the support-chat rows and filter on it explicitly in every public/HMAC query, in addition to the WorkspaceContext::set() chokepoint. Design 1 relies on the chokepoint alone plus `withoutGlobalScopes()` single-row code lookups. Design 2's belt-and-braces (`even a wrong room_id join cannot cross tenants because workspace_id is also in the WHERE`) costs nothing and is the only defence that survives a future contributor who does not know WorkspaceScope no-ops silently.


## MANDATORY fixes — verified blockers. Each ships a bug or a vulnerability if ignored.

1. D1 and D3 — visitor upload completion cannot work as specified. Verified at `apps/api/app/Domain/Media/UploadService.php:119-121`: `public function complete(Attachment $attachment, User $uploader, ?array $parts = null)` takes a non-nullable `User` and its first statement is `if ($attachment->uploader_id !== $uploader->id) { throw ApiException::msgAttachmentInvalid(); }`. D1's API-207 says it is 'byte-for-byte the API-060/061 flow, reusing `UploadService::create()` and `::complete()`' — a visitor has no User, so this is a TypeError on the first visitor upload. D3 addresses `create()` ('passes `uploader: null, publicChatRoom: $pc->room_id` into `UploadService::create()`') and is silent on `complete()`. D2 alone specifies a sibling `completeForPublicChat(Attachment $a, PublicChatRoom $room)` asserting `public_chat_room_id === $room->id`. Whichever design ships, this method must be forked, not reused.

2. D1 and D3 — the `r.type != 'support'` filter in `CallService::allowed()` is load-bearing, not belt-and-braces, and both designs describe it as the latter. Verified at `apps/api/app/Domain/Calls/CallService.php:20-33`: the query requires a `room_members` row with `left_at IS NULL` plus an active workspace member. Under lazy materialization, the moment an agent opens a support room they GET exactly such a row — so lazy membership ACTIVELY OPENS the call surface, and the filter is the only thing closing it. D1 calls the client-side gate 'belt to `CallService::allowed`'s braces'; it is the reverse. If a future edit to that raw-SQL method drops the predicate, calls silently become available in customer-facing rooms. D2 is immune: the room id is not in `rooms`, so the join cannot resolve.

3. D3 — the `greeting` field breaks its own core invariant and hands the partner support-side authorship. It writes a row with `sender_id = NULL` plus `metadata.pchat_from = 'support'`, but D3's partial unique index is `WHERE sender_id IS NULL` and its `VisitorMessageSerializer` derives `from === 'visitor'` from a NULL sender. So the greeting is both a visitor row for idempotency purposes and a support row for rendering purposes, depending on which code path reads it — and it contradicts D3's own claim that 'every external message maps to a real internal user'. The design text visibly reverses itself mid-sentence ('...and `type = system`… **no**: it is written with...'). Drop the field, or give it a real sender.

4. D1 — the feature ships live. `'publicchat.enabled' => true` in `SettingsService::DEFAULTS` means the migration deploy turns customer-facing public chat ON before any admin has opted in. Part 2 of the requirement is 'turn off this feature'; the safe default for a new externally-reachable surface is off. D2 and D3 both ship dark.

5. D1 — the capability secret is in the broadcast channel name. `private-support.{code}` places the 64-hex credential into the channel string, which travels in every WebSocket subscribe frame, is the signed input to `socket_id:channel_name`, and lands in any Reverb-side logging or debug console. D1's own API-203 already returns `room_id`; D2 (`private-public-chat.{room_id}`) and D3 (`private-pchat.{room_id}`) both use the ULID. Use the room id.

6. D1 and D2 — raw `problem` status reaches the visitor. D1's API-203 returns `"status":"in_progress"` from the same field that can hold `problem`, and D2's API-210 returns raw `status` with EVT-081 broadcasting `{status, can_send}` to the visitor channel. A customer discovering that support flagged their conversation as a problem is an information disclosure with a real business cost. Only D3 projects it.

7. ALL THREE — the visitor channel-auth endpoint's string-equality assertion is the entire tenancy boundary, and nothing backs it up. `config/reverb.php:85` is `allowed_origins => ['*']` and there is no `config/cors.php`, so neither constrains anything. If `channel_name === 'private-<x>.'.$id` is ever loosened to a prefix, regex, or `str_starts_with` — the kind of edit that looks like a harmless generalisation — one visitor's code subscribes to every other customer's transcript. This must ship with the test that asserts a 403 for another room's channel AND for the staff channel, and with a comment on the line saying why it is not a pattern match.

8. ALL THREE — `WorkspaceScope` fails open and fails silently on exactly the two new surfaces. Verified at `apps/api/app/Models/Scopes/WorkspaceScope.php:16-24`: it applies a `where` only `if ($workspaceId !== null)` and otherwise returns every workspace's rows, with no exception and no log. Public and HMAC routes carry no `workspace.context` middleware. Any query added later to these controllers by someone who does not know this is a cross-tenant leak that passes code review and passes tests. D2's mitigation is the strongest of the three — put no `WorkspaceScope` on the new models at all, so a forgotten `where('workspace_id', ...)` is a visible bug rather than an invisible leak — and it should be stated in the migration and model docblocks, not just the design.

9. ALL THREE — Decision C's 'stored hashed' is not implementable and all three correctly amend it, but the amendment must land as a DEC before code. HMAC verification requires recomputing `hash_hmac($canonical, $secret)`, which requires the plaintext; a digest cannot supply key material. Storage becomes `Crypt::encryptString` under APP_KEY (the `ai_providers.api_key_encrypted` precedent). Shown-once, `$hidden`, never round-tripped, and revocable all survive; the at-rest boundary moves from 'DB dump' to 'DB dump AND APP_KEY'. If this is not written down as a DEC, the next reviewer will 'fix' it back to a hash and silently break every integration.

10. ALL THREE — the spec forbids this feature today and CLAUDE.md forbids shipping it anyway. Verified in PRODUCT_SPEC.md §1.3: NG5 'Guest / external user ข้าม workspace' and NG6 'Bot / Webhook / Integration API', plus Appendix C's parking lot listing both 'Bots/Webhooks' and 'Guest access'. A DEC in §15 and a Changelog row in §16 must land amending all of them BEFORE any FR-PCHAT is written, and the DEC must state its bound explicitly (guest access limited to exactly one room via one capability link with no workspace identity; the partner API creates rooms only and can never send or read as a user) or the next request will cite it as licence for a general integration API.

11. ALL THREE — the brief's 'Filament v4' is wrong and would not compile. Verified: `apps/api/composer.json:10` pins `"filament/filament": "^3.3"`, `composer.lock:1373` resolves `v3.3.55`, and `PRODUCT_SPEC.md:139` says 'Filament 3'. All three designs caught this independently, which is a good sign, but the error is in the task brief itself and will keep re-entering through anyone who trusts it. Correct it at the source. The v3 traps all three name are real: `ListRecords` registers no header actions by default, and `Settings::form()` does `[$min,$max] = self::ranges()[$key]` with no guard, so a numeric setting added to `DEFAULTS` without a `ranges()` entry takes down the entire settings page — the very page that turns the feature off.

12. THE VISITOR'S SECRET CODE MUST NEVER APPEAR IN A CHANNEL NAME. Design 1 broadcasts EVT-071/072/073/074 on 'private-support.{code}'. A Pusher-protocol channel name is public by construction: it appears in every WebSocket frame, in the pusher:subscription_succeeded echo, in the visitor's browser devtools, in the API-208 request body, and in any Reverb/Pulse channel listing. Because RealtimeEvent implements ShouldBroadcast rather than ShouldBroadcastNow (verified, app/Events/RealtimeEvent.php), broadcast delivery also runs through queued jobs and exception paths where the channel string can surface in failed_jobs. Key the channel on the room ULID (Designs 2 and 3 do) regardless of which design wins.

13. SOCKET_ID MUST BE VALIDATED AT THE VISITOR CHANNEL-AUTH ENDPOINT. Pusher::authorizeChannel validates socket_id against /\A\d+\.\d+\z/ and the channel against /\A#?[-a-zA-Z0-9_=@,.;]+\z/ (vendor/pusher/pusher-php-server/src/Pusher.php:208, 222, 895-898). Design 3 hand-rolls hash_hmac('sha256', $request->string('socket_id').':'.$channel, secret) with no validation whatsoever; Design 1's own /^\d+\.\d+$/ is weak because PCRE '$' matches before a trailing newline. Delegate to Broadcast::driver()->validAuthenticationResponse($request, []) as Design 2 does, or anchor with \A...\z.

14. THE VISITOR CHANNEL-AUTH ENDPOINT IS AN UNAUTHENTICATED SIGNING ORACLE OVER THE REVERB APP SECRET, in all three designs. It is safe today only because the channel is pinned as the suffix of the signed string and socket_id is format-restricted. If the channel assertion is ever relaxed from literal string equality to a prefix, regex, or str_starts_with match, it becomes cross-room and cross-channel forgery — and neither config/reverb.php ('allowed_origins' => ['*']) nor CORS (no config/cors.php, framework defaults) is a backstop. The equality assertion needs a dedicated security test asserting that a request for another room's channel AND for the staff channel both 403.

15. VISITOR MESSAGES PRODUCE ZERO NOTIFICATIONS, SILENTLY, in any design that shares the messages table. Verified at Jobs/NotifyMessage.php:56-59 — `$senderUser = $message->sender()->first(); if ($senderUser === null) { return; }`, with the in-code comment 'system messages never reach here (writer skips), belt+braces'. No exception, no log. Designs 1 and 3 both flag it; it must actually be branched, or the agent is never told a customer wrote and the feature's entire purpose fails quietly.

16. AttachmentProcessed BROADCASTS TO PrivateChannel('user.'.$uploader_id) (app/Events/AttachmentProcessed.php:29). Once uploader_id is nullable, a visitor upload emits on the dead channel 'private-user.' and the visitor's own image or video thumbnail never appears until they reload. All three designs need this branch (D1 names it, D2 makes it EVT-084, D3 makes it EVT-087) — it is not optional polish, it is the visitor watching their own upload never finish.

17. Settings::form() DOES `[$min,$max] = self::ranges()[$key]` WITH NO GUARD (verified, app/Filament/Pages/Settings.php:71). Adding any numeric publicchat.* key to SettingsService::DEFAULTS without a matching Settings::ranges() entry throws on the settings page — taking down the very page an admin uses to turn the feature off. All three designs warn about it; it must land as code, not as a note.

18. DECISION C AS WRITTEN IS UNIMPLEMENTABLE AND ALL THREE DESIGNS CORRECTLY AMEND IT. HMAC verification must recompute the MAC with the key material, so a sha256/bcrypt digest cannot be used; the secret must be Crypt::encryptString under APP_KEY, as ai_providers.api_key_encrypted already is. The consequence only Design 1 states must be recorded: APP_KEY rotation now invalidates every partner secret, because Crypt::decryptString will fail for all of them. This belongs in the APP_KEY rotation runbook or the first rotation silently breaks every customer integration.

19. THE PLAINTEXT SECRET ROUND-TRIPS THROUGH A LIVEWIRE RESPONSE. In all three designs the only place the secret ever exists is a Filament Notification::make()->body($secret)->persistent(). That response must carry Cache-Control: no-store, and the secret must be proven absent from the audit_logs payload and from any Livewire component state that could be re-rendered. All three promise 'never the secret' in the audit entry; make it an assertion in a test, not a sentence in a design.

20. customer_name / provider_name / extra ARE ATTACKER-CONTROLLED AND RENDER ON THREE SURFACES (visitor SPA, agent SPA, Filament transcript). They must never reach the Markdown renderer, never be passed to a Filament TextColumn ->html(), and never be emitted through {!! !!} in a blade. The 'provider name (admin username)' label must be assembled server-side and rendered as a plain text node. Control-character stripping and a length cap must happen at ingest, since that is the only defence that travels with the data into a future email template, push payload or export.

21. PRODUCT_SPEC.md NON-GOALS NG5 (guest/external user) AND NG6 (bot/webhook/integration API) BOTH EXCLUDE THIS FEATURE TODAY (verified at PRODUCT_SPEC.md:62-63), as does the Appendix C parking lot with both 'Guest access' and 'Bots/Webhooks'. Per CLAUDE.md a DEC in §15 plus a §16 Changelog row must land amending all of them BEFORE any FR-PCHAT-* is written, and the DEC must state its own bound (guest access limited to exactly one room via one capability link with no workspace identity; the partner API creates rooms only and can never send or read as a user) or the next request will cite it as licence for a general integration API. Note the current maxima are DEC-059, EVT-070, API-164 — all three designs' ID ranges are free.

22. RoomType IS A BACKED-ENUM CAST ON Models/Room.php:43. In Designs 1 and 3, a row with type='support' reaching RoomController::summarize's RoomType::from($row->type) before the enum case is deployed throws ValueError and 500s the entire room list for the workspace. This is a deploy-ordering constraint, not just a code change. Design 2 is immune because it adds no room type.

23. UploadService cannot accept a visitor as written — and Design 1, the winner, claims it can. `UploadService::create(User $uploader, string $workspaceId, array $input)` (apps/api/app/Domain/Media/UploadService.php:39) and `UploadService::complete(Attachment $attachment, User $uploader, ?array $parts = null)` (line 119) both take a non-nullable User, and complete()'s first statement is `if ($attachment->uploader_id !== $uploader->id)` (line 121). `UploadController::store` additionally passes `$request->user()` straight through, which is null on a public route. Any design that says 'reuse UploadService unchanged' for visitor uploads does not compile. New sibling methods are required.

24. `attachments.uploader_id` is NOT NULL — `$table->foreignUlid('uploader_id')->constrained('users')->cascadeOnDelete()` (2026_09_07_000006_create_attachments_table.php:14), unlike `messages.sender_id`. Visitor file/video upload is not merely broken, it is impossible, until that column is made nullable. All three designs migrate it; none may be skipped.

25. `AttachmentProcessed::channels()` returns `[new PrivateChannel('user.'.$this->attachment->uploader_id)]` (apps/api/app/Events/AttachmentProcessed.php:29 — verified). With a NULL uploader_id the channel name is the literal string `user.` — a live, subscribable, cross-tenant channel that any authenticated user could in principle be granted if the `user.{userId}` callback ever matched an empty id, and in the best case a dead channel so the visitor's own thumbnail never appears without a reload. This must be branched, not left to be discovered.

26. Visitor messages produce ZERO push notifications and fail completely silently. `Jobs/NotifyMessage.php` does `$senderUser = $message->sender()->first(); if ($senderUser === null) { return; }` (lines ~56-59, verified) with no exception and no log. The support agent is never told a customer wrote to them, which defeats the feature. `PushDecisionService` further dereferences `$sender->display_name`, so the support branch must supply customer_name as the display name rather than just removing the early return.

27. Nobody can delete a visitor message. `MessageEditor::assertDeletableBy` (verified) returns 'sender' only when `$message->sender_id === $actor->id` — a NULL sender can never match — then requires `in_array($membership->role, [RoomRole::Owner, RoomRole::Admin], true)` or throws `roomForbidden()`. Lazily-created support memberships default to `role='member'` (rooms migration line 39). The content most likely to need removal (a customer pasting a card number, a malicious upload) is unremovable by anyone. A support-room branch is mandatory for Designs 1 and 3; Design 2 sidesteps it with its own DELETE endpoint.

28. The AI bot will answer paying customers. `MessageController` dispatches on `if ($created && ! $room->isDm() && GenerateRoomBotReply::mentioned($message->body))` (line ~142, verified). A support room is non-DM, so a customer typing the bot's mention token gets an unprompted AI reply in the provider's name. Designs 1 and 3 both flag it; it must actually be implemented, not just noted. Design 2 is structurally immune.

29. `RoomType::from($row->type)` is called at RoomController.php:585 and :608 (verified — the ternary `$row->type instanceof RoomType ? $row->type : RoomType::from($row->type)` still throws ValueError on an unknown string), and `Models/Room.php` casts the column to the backed enum. The `Support` case must be added to `app/Enums/RoomType.php` (currently only `Dm` and `Group`) and DEPLOYED before the first `type='support'` row exists, or one stray row 500s the entire room list for every member of the workspace. This is a deploy-ordering constraint, not just a code change.

30. `WorkspaceScope::apply()` (verified) does `if ($workspaceId !== null) { $builder->where(...) }` — it no-ops with no throw and no log when no workspace context is set. Public and HMAC routes carry no `workspace.context` middleware, so any un-scoped `Room::find()` / `Message::query()` on those paths returns every tenant's rows while looking like correct code. Every design must set WorkspaceContext at a single chokepoint AND filter workspace_id explicitly; neither alone is sufficient against future edits.

31. Decision C is not implementable as written and all three designs correctly amend it — but the amendment must be recorded, not assumed. HMAC verification requires recomputing `hash_hmac('sha256', $canonical, $secret)`, which requires the plaintext; a sha256/bcrypt digest cannot be used as a key. Storage must be `Crypt::encryptString` under APP_KEY, matching `AiProvider::$api_key_encrypted` + `api_key_last4` + `$hidden = ['api_key_encrypted']` + `plainApiKey()` (verified in app/Models/AiProvider.php). Consequence to add to the APP_KEY rotation runbook: rotating APP_KEY invalidates every partner secret, since `Crypt::decryptString` will fail for all of them.

32. Adding any numeric `publicchat.*` key to `SettingsService::DEFAULTS` without a matching `Settings::ranges()` entry throws and takes down the ENTIRE runtime settings page — the very page that turns the feature off. Verified: `Settings::form()` does `[$min,$max] = self::ranges()[$key];` with no isset guard (app/Filament/Pages/Settings.php). Note also that a string-typed setting is impossible here: string defaults are forced through `->maxLength(40)` and a semver-only regex, so link TTLs and limits must be int/float, never string.

33. The visitor channel-auth endpoint's literal string-equality check is the ONLY tenancy boundary on the realtime path. `config/reverb.php` sets `allowed_origins => ['*']` and there is no `config/cors.php`, so neither constrains anything. `PusherBroadcaster::validAuthenticationResponse()` (verified, lines 104-113) short-circuits on `str_starts_with($request->channel_name, 'private')` and signs whatever channel name it is handed — it performs no ownership check of its own. If that equality is ever relaxed to a prefix, regex or str_contains match, one visitor subscribes to every other customer's conversation. It must be a security test, not an integration test.

34. Named rate limiters are mandatory; numeric `throttle:N,1` is not acceptable here. The codebase documents at routes/api.php:192 that stacked numeric throttles share one cache key per resolved user-or-IP across every numerically-throttled route on the domain. The partner calls from ONE server IP, so partner limiters must key on the API key id, and visitor limiters must key on the code — not IP. Separately: `RateLimiter::for('api')` is defined but never applied anywhere (grep 'throttle:api' returns nothing), so there is no app-level backstop; nginx `limit_req zone=edge_api rate=300r/m burst=150` per source IP is the only ceiling and a busy partner hits it from its single IP regardless of app tuning.
