<?php

use App\Http\Controllers\Api\V1\AiController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\BrandingController;
use App\Http\Controllers\Api\V1\CallController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\InviteRedemptionController;
use App\Http\Controllers\Api\V1\KanbanController;
use App\Http\Controllers\Api\V1\MeController;
use App\Http\Controllers\Api\V1\MeetingController;
use App\Http\Controllers\Api\V1\MessageController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\PublicChatAgentController;
use App\Http\Controllers\Api\V1\PublicChatPartnerController;
use App\Http\Controllers\Api\V1\PublicChatVisitorController;
use App\Http\Controllers\Api\V1\RoomController;
use App\Http\Controllers\Api\V1\RoomToolsController;
use App\Http\Controllers\Api\V1\SearchController;
use App\Http\Controllers\Api\V1\UploadController;
use App\Http\Controllers\Api\V1\WorkspaceController;
use App\Http\Controllers\Api\V1\WorkspaceInviteController;
use App\Http\Controllers\SetupController;
use App\Http\Middleware\DenyExpiredSecretAttachment;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| API Routes — spec §8, prefix /api/v1 (§7 versioning)
|--------------------------------------------------------------------------
*/

Route::prefix('v1')->group(function (): void {
    // API-090: WebSocket auth via POST /broadcasting/auth with bearer token
    Broadcast::routes(['middleware' => ['auth:api']]);

    Route::prefix('auth')->group(function (): void {
        Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:login');
        Route::post('/refresh', [AuthController::class, 'refresh'])->middleware('throttle:refresh');

        Route::middleware(['auth:api', 'account.active', 'password.fresh'])->group(function (): void {
            Route::post('/logout', [AuthController::class, 'logout']);
            Route::post('/logout-all', [AuthController::class, 'logoutAll']);
            Route::post('/change-password', [AuthController::class, 'changePassword']);
        });
    });

    Route::middleware(['auth:api', 'account.active', 'password.fresh'])->group(function (): void {
        Route::get('/me', [MeController::class, 'show']);
        Route::patch('/me', [MeController::class, 'update']);
        Route::get('/me/workspaces', [MeController::class, 'workspaces']);
        Route::get('/me/sessions', [AuthController::class, 'sessions']);
        Route::delete('/me/sessions/{sessionId}', [AuthController::class, 'revokeSession'])
            ->whereUlid('sessionId');

        // API-070/072 + focus reporting (auth, workspace-agnostic)
        Route::put('/me/devices/{deviceId}', [NotificationController::class, 'updateDevice'])->whereUlid('deviceId');
        Route::put('/me/notification-settings', [NotificationController::class, 'updateSettings']);
        Route::post('/me/focus', [NotificationController::class, 'focus']);

        // AI — user-owned resources; workspace header only gates/attributes
        // (DEC-015). Memories need no workspace context (DEC-016).
        Route::get('/ai/memories', [AiController::class, 'memories'])->middleware('workspace.context'); // API-110
        Route::post('/ai/memories', [AiController::class, 'addMemory'])->middleware('workspace.context'); // API-113
        Route::post('/ai/memories/clear', [AiController::class, 'clearMemories']); // API-112
        Route::delete('/ai/memories/{memoryId}', [AiController::class, 'deleteMemory'])->whereUlid('memoryId'); // API-111
        Route::post('/ai/consent', [AiController::class, 'consent']); // API-109
        Route::get('/ai/messages/{messageId}', [AiController::class, 'showMessage'])->whereUlid('messageId'); // API-117
        Route::post('/ai/messages/{messageId}/cancel', [AiController::class, 'cancel'])->whereUlid('messageId'); // API-108

        Route::middleware('workspace.context')->group(function (): void {
            Route::get('/ai/status', [AiController::class, 'status']); // API-100
            Route::get('/ai/conversations', [AiController::class, 'conversations']); // API-101
            Route::post('/ai/conversations', [AiController::class, 'createConversation']); // API-102
            Route::get('/ai/conversations/{conversationId}', [AiController::class, 'showConversation'])->whereUlid('conversationId'); // API-103
            Route::patch('/ai/conversations/{conversationId}', [AiController::class, 'updateConversation'])->whereUlid('conversationId'); // API-104
            Route::delete('/ai/conversations/{conversationId}', [AiController::class, 'deleteConversation'])->whereUlid('conversationId'); // API-105
            Route::get('/ai/conversations/{conversationId}/messages', [AiController::class, 'messages'])->whereUlid('conversationId'); // API-106
            Route::post('/ai/conversations/{conversationId}/messages', [AiController::class, 'send'])
                ->whereUlid('conversationId')->middleware('throttle:ai-send'); // API-107
            Route::post('/ai/conversations/{conversationId}/focus', [AiController::class, 'focus'])->whereUlid('conversationId'); // API-118
            Route::post('/ai/messages/{messageId}/regenerate', [AiController::class, 'regenerate'])
                ->whereUlid('messageId')->middleware('throttle:ai-send'); // API-114 (FR-AI-009)
            Route::patch('/ai/messages/{messageId}', [AiController::class, 'editMessage'])
                ->whereUlid('messageId')->middleware('throttle:ai-send'); // API-115 (FR-AI-009)
            Route::post('/ai/messages/{messageId}/share', [AiController::class, 'share'])
                ->whereUlid('messageId'); // FR-AI-015
            Route::get('/ai/search', [AiController::class, 'search']); // API-116 (FR-AI-020)
        });
    });

    // Workspace-scoped routes — X-Workspace-Id required (FR-WS-003 isolation)
    Route::get('/public-meetings/{code}', [MeetingController::class, 'show'])->where('code', '[a-f0-9]{64}')->middleware('throttle:120,1');
    Route::post('/public-meetings/{code}/join', [MeetingController::class, 'join'])->where('code', '[a-f0-9]{64}')->middleware('throttle:20,1');
    Route::post('/public-meetings/{code}/leave', [MeetingController::class, 'leave'])->where('code', '[a-f0-9]{64}')->middleware('throttle:60,1');
    Route::get('/calls/authorize-media', [CallController::class, 'authorizeMedia']);

    // API-232/233 — FR-AUTH-008/DEC-081. PUBLIC, unauthenticated: the token is
    // the only credential. Declared per-route (not on a group) so a malformed
    // token 404s at routing, matching the public-chat {code} convention below.
    Route::get('/join/{token}', [InviteRedemptionController::class, 'show'])
        ->where('token', '[a-f0-9]{64}')->middleware('throttle:invite-preview'); // API-232
    Route::post('/join/{token}', [InviteRedemptionController::class, 'store'])
        ->where('token', '[a-f0-9]{64}')->middleware('throttle:invite-join'); // API-233

    // API-234/235 — FR-ADM-015/DEC-082. PUBLIC, unauthenticated: the logo
    // must render on /login and /join/:token before any session exists.
    Route::get('/app-config', [BrandingController::class, 'config'])->middleware('throttle:120,1'); // API-234
    Route::get('/branding/logo', [BrandingController::class, 'logo'])->middleware('throttle:120,1'); // API-235

    /*
    |----------------------------------------------------------------------
    | PUBLIC CHAT — FR-PCHAT. THREE TIERS, THREE TRUST MODELS.
    |----------------------------------------------------------------------
    |
    | TIER 1 `partner/public-chat/*`  machine client, HMAC-signed (api.hmac)
    | TIER 2 `public-chat/{code}/*`   UNAUTHENTICATED, the code IS the credential
    | TIER 3 `public-chat/rooms/*`    authenticated active workspace member
    |
    | THE `partner/` PREFIX IS LOAD-BEARING. Without it, partner
    | GET /public-chat/rooms/{id} and agent GET /public-chat/rooms/{id} are the
    | same path in two middleware groups disambiguated only by a route regex —
    | and a dropped ->where() would silently reroute a customer request into the
    | AUTHENTICATED handler. It also gives the nginx `access_log off` exemption
    | a path to match on.
    |
    | EVERY LIMITER IS NAMED, NEVER numeric `throttle:N,1`. As already documented
    | further down this file, stacked numeric throttles share ONE cache key per
    | resolved user-or-IP across every numerically-throttled route on the domain.
    | Tier 1 keys on the API key id because the partner calls from ONE server IP;
    | Tier 2 keys on the room code so one noisy visitor cannot exhaust another's
    | budget. See AppServiceProvider::boot().
    */

    // ---- TIER 1 — partner, HMAC. Rooms addressed BY ULID, never by {code} ---
    // A {code} path would put the VISITOR'S bearer credential in the partner's
    // outbound HTTP logs, in any intermediate proxy and in our own nginx access
    // log on every status poll (MANDATORY graft 12). ->whereUlid makes a 64-hex
    // value in {id} a plain 404.
    Route::prefix('partner/public-chat')->middleware('api.hmac')->group(function (): void {
        Route::post('/rooms', [PublicChatPartnerController::class, 'store'])
            ->middleware('throttle:pchat-create'); // API-200
        Route::get('/rooms/{id}', [PublicChatPartnerController::class, 'show'])
            ->whereUlid('id')->middleware('throttle:pchat-partner'); // API-201
        Route::post('/rooms/{id}/close', [PublicChatPartnerController::class, 'close'])
            ->whereUlid('id')->middleware('throttle:pchat-partner'); // API-202
        Route::post('/rooms/{id}/rotate-link', [PublicChatPartnerController::class, 'rotateLink'])
            ->whereUlid('id')->middleware('throttle:pchat-partner'); // API-203
    });

    // ---- TIER 2 — visitor, UNAUTHENTICATED ---------------------------------
    // Outside every auth group by construction. ->where('code', '[a-f0-9]{64}')
    // makes a malformed code 404 at ROUTING, before it can touch the database,
    // and keeps these paths from colliding with the Tier-3 literals below
    // ('rooms', 'summary', 'messages' can never match 64 hex chars).
    // THE CONSTRAINT IS DECLARED PER ROUTE, NEVER ON THE GROUP. `Route::prefix()
    // ->group(...)->where(...)` does NOT propagate the pattern to the routes
    // inside the group, and without it `/public-chat/{code}` swallows the Tier-3
    // literals `/public-chat/rooms` and `/public-chat/summary` — which is a
    // silent reroute of an AUTHENTICATED endpoint into the UNAUTHENTICATED
    // handler, exactly the failure the `partner/` prefix exists to prevent on
    // the other side. Verified by the Tier-3 tests, which 404 without it.
    $pchatCode = '[a-f0-9]{64}';

    Route::prefix('public-chat')->group(function () use ($pchatCode): void {
        Route::get('/{code}', [PublicChatVisitorController::class, 'show'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-read'); // API-210
        Route::get('/{code}/messages', [PublicChatVisitorController::class, 'messages'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-read'); // API-211
        Route::post('/{code}/messages', [PublicChatVisitorController::class, 'send'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-write'); // API-212
        Route::post('/{code}/uploads', [PublicChatVisitorController::class, 'createUpload'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-upload'); // API-213
        Route::post('/{code}/uploads/{attachment}/complete', [PublicChatVisitorController::class, 'completeUpload'])
            ->where('code', $pchatCode)->whereUlid('attachment')->middleware('throttle:pchat-visitor-upload'); // API-214
        // API-215 — the visitor channel-auth endpoint. An UNAUTHENTICATED SIGNING
        // ORACLE over the Reverb app secret; see the controller's comment block
        // before touching it.
        Route::post('/{code}/broadcasting/auth', [PublicChatVisitorController::class, 'broadcastAuth'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-read');
        Route::post('/{code}/typing', [PublicChatVisitorController::class, 'typing'])
            ->where('code', $pchatCode)->middleware('throttle:pchat-visitor-write'); // API-216
    });

    Route::middleware(['auth:api', 'account.active', 'password.fresh', 'workspace.context'])->group(function (): void {
        Route::get('/meetings', [MeetingController::class, 'index']);
        Route::post('/meetings', [MeetingController::class, 'create'])->middleware('throttle:10,1');
        Route::post('/meetings/{id}/end', [MeetingController::class, 'end'])->whereUlid('id')->middleware('throttle:30,1');
        Route::get('/calls', [CallController::class, 'index']);
        Route::post('/rooms/{id}/calls', [CallController::class, 'start'])->whereUlid('id')->middleware('throttle:30,1');
        foreach (['join', 'leave', 'end', 'decline'] as $action) {
            Route::post('/calls/{id}/'.$action, [CallController::class, $action])->whereUlid('id')->middleware('throttle:60,1');
        }
        // API-140..148 / FR-KAN-001..005
        Route::get('/board', [KanbanController::class, 'board']);
        Route::post('/board/lanes', [KanbanController::class, 'createLane']);
        Route::patch('/board/lanes/{id}', [KanbanController::class, 'updateLane'])->whereUlid('id');
        Route::delete('/board/lanes/{id}', [KanbanController::class, 'deleteLane'])->whereUlid('id');
        Route::get('/board/tickets', [KanbanController::class, 'tickets']);
        Route::post('/board/tickets', [KanbanController::class, 'create']);
        Route::get('/board/tickets/{id}', [KanbanController::class, 'show'])->whereUlid('id');
        Route::patch('/board/tickets/{id}', [KanbanController::class, 'update'])->whereUlid('id');
        Route::post('/board/tickets/{id}/comments', [KanbanController::class, 'comment'])->whereUlid('id');

        Route::get('/workspace', [WorkspaceController::class, 'show']);
        // API-230/231 — FR-WS-006/DEC-081. Permission (ws admin+) is checked
        // inside WorkspaceInviteService, matching RoomPolicy::isWsAdmin's style.
        Route::post('/workspace-invites', [WorkspaceInviteController::class, 'store'])->middleware('throttle:invite-issue');
        Route::delete('/workspace-invites/{id}', [WorkspaceInviteController::class, 'destroy'])->whereUlid('id');
        Route::get('/directory', [WorkspaceController::class, 'directory']);
        Route::get('/members', [WorkspaceController::class, 'members']);
        Route::get('/sync', [WorkspaceController::class, 'sync']);
        Route::get('/me/mentions', [MeController::class, 'mentions']); // API-044 (auth ws)

        // FR-NOTI-006 — feed spans workspaces (session_revoked is account
        // level); the ws header only authenticates the caller's membership.
        Route::get('/me/notifications', [NotificationController::class, 'index']); // API-073
        Route::post('/me/notifications/read', [NotificationController::class, 'markRead']);

        Route::get('/search/messages', [SearchController::class, 'messages']); // API-080
        Route::get('/search/files', [SearchController::class, 'files']); // API-081

        // Room params resolve inside the controller (RoomController::roomOrFail):
        // SubstituteBindings runs before workspace.context sets the scope, so
        // implicit binding here would leak cross-workspace rooms.

        Route::get('/rooms/{roomId}/notes', [RoomToolsController::class, 'notes'])->whereUlid('roomId');
        Route::post('/rooms/{roomId}/notes', [RoomToolsController::class, 'createNote'])->whereUlid('roomId');
        Route::patch('/rooms/{roomId}/notes/{noteId}', [RoomToolsController::class, 'updateNote'])->whereUlid('roomId');
        Route::delete('/rooms/{roomId}/notes/{noteId}', [RoomToolsController::class, 'deleteNote'])->whereUlid('roomId');
        Route::get('/rooms/{roomId}/pins', [RoomToolsController::class, 'pins'])->whereUlid('roomId');
        Route::put('/rooms/{roomId}/pins/{messageId}', [RoomToolsController::class, 'pin'])->whereUlid('roomId');
        Route::delete('/rooms/{roomId}/pins/{messageId}', [RoomToolsController::class, 'unpin'])->whereUlid('roomId');
        Route::post('/rooms/{roomId}/typing', [RoomToolsController::class, 'typing'])->whereUlid('roomId');

        // ---- TIER 3 — support agents (FR-PCHAT-004/005/006/009/010) --------
        // Authorisation is Decision A: active WorkspaceMember of X-Workspace-Id,
        // which this group's workspace.context middleware has already proved.
        // No room-level role, no room_members row, no new role — "all support
        // can see all room + message". Declared BEFORE the /rooms block below
        // so these literal paths are never shadowed.
        Route::get('/public-chat/rooms', [PublicChatAgentController::class, 'index']); // API-220
        Route::get('/public-chat/summary', [PublicChatAgentController::class, 'summary']); // API-227
        Route::get('/public-chat/rooms/{id}', [PublicChatAgentController::class, 'show'])->whereUlid('id'); // API-221
        Route::patch('/public-chat/rooms/{id}', [PublicChatAgentController::class, 'update'])->whereUlid('id'); // API-224
        Route::get('/public-chat/rooms/{id}/messages', [PublicChatAgentController::class, 'messages'])->whereUlid('id'); // API-222
        Route::post('/public-chat/rooms/{id}/messages', [PublicChatAgentController::class, 'send'])
            ->whereUlid('id')->middleware('throttle:pchat-agent-write'); // API-223
        Route::post('/public-chat/rooms/{id}/uploads', [PublicChatAgentController::class, 'createUpload'])
            ->whereUlid('id')->middleware('throttle:pchat-agent-write'); // API-225
        Route::post('/public-chat/rooms/{id}/read', [PublicChatAgentController::class, 'markRead'])->whereUlid('id'); // API-228
        Route::post('/public-chat/rooms/{id}/typing', [PublicChatAgentController::class, 'typing'])
            ->whereUlid('id')->middleware('throttle:pchat-agent-typing'); // EVT-085 staff side
        Route::delete('/public-chat/messages/{id}', [PublicChatAgentController::class, 'destroyMessage'])->whereUlid('id'); // API-226

        Route::get('/rooms', [RoomController::class, 'index']);
        Route::post('/rooms', [RoomController::class, 'store']);
        Route::get('/rooms/{room}', [RoomController::class, 'show'])->whereUlid('room');
        Route::patch('/rooms/{room}', [RoomController::class, 'update'])->whereUlid('room');
        Route::delete('/rooms/{room}', [RoomController::class, 'destroy'])->whereUlid('room');

        Route::get('/rooms/{room}/members', [RoomController::class, 'members'])->whereUlid('room');
        Route::post('/rooms/{room}/members', [RoomController::class, 'addMembers'])->whereUlid('room');
        Route::delete('/rooms/{room}/members/{userId}', [RoomController::class, 'removeMember'])->whereUlid(['room', 'userId']);
        Route::patch('/rooms/{room}/members/{userId}', [RoomController::class, 'updateMemberRole'])->whereUlid(['room', 'userId']);
        Route::post('/rooms/{room}/leave', [RoomController::class, 'leave'])->whereUlid('room');

        Route::get('/rooms/{room}/messages', [MessageController::class, 'index'])->whereUlid('room');
        Route::post('/rooms/{room}/messages', [MessageController::class, 'store'])->whereUlid('room');
        Route::post('/rooms/{room}/read', [MessageController::class, 'markRead'])->whereUlid('room');
        Route::get('/rooms/{room}/read-status', [MessageController::class, 'readStatus'])->whereUlid('room');
        Route::put('/rooms/{room}/notifications', [NotificationController::class, 'roomSettings'])->whereUlid('room'); // API-071

        // API-042/043 — edit/delete (FR-MSG-005/006); params resolve in-controller
        Route::patch('/messages/{message}', [MessageController::class, 'update'])->whereUlid('message');
        Route::delete('/messages/{message}', [MessageController::class, 'destroy'])->whereUlid('message');

        // API-060/061/062 — media (FR-MEDIA-001/004). Params resolve in-controller.
        Route::post('/uploads', [UploadController::class, 'store']);
        Route::post('/uploads/{attachment}/complete', [UploadController::class, 'complete'])->whereUlid('attachment');
        Route::get('/attachments/{attachment}', [UploadController::class, 'show'])->whereUlid('attachment');
    });

    // Local-disk media plumbing — signature-checked, no bearer/ws headers
    // (same trust model as an S3 presigned URL; see MediaUrls).
    Route::prefix('v1')->group(function (): void {
        Route::put('/uploads/{attachment}/binary', [UploadController::class, 'binary'])
            ->middleware('signed')
            ->whereUlid('attachment')->name('uploads.binary');

        // FR-ROOM-012 — the secret-room deadline is checked BEFORE `signed` so
        // an expired secret attachment answers 404 ("no leak") instead of the
        // 403 that stale signature validation would emit first. Ordering is
        // load-bearing: group middleware always runs ahead of route middleware,
        // so `signed` is declared per-route here rather than on the group.
        Route::get('/attachments/{attachment}/file/{variant}', [UploadController::class, 'file'])
            ->middleware([DenyExpiredSecretAttachment::class, 'signed'])
            ->whereUlid('attachment')
            ->whereIn('variant', ['original', 'thumb_sm', 'thumb_md', 'poster'])
            ->name('attachments.file');
    });

    Route::get('/health', [HealthController::class, 'index']);

    // FR-SETUP — first-run installer (API-120..123). Unauthenticated by
    // design: the instance has no users yet, and RequireSetupCompleted
    // locks every endpoint the moment installation finishes. Named
    // limiters: stacked numeric throttles would share one cache key.
    Route::prefix('setup')->middleware('throttle:setup')->group(function (): void {
        Route::get('/status', [SetupController::class, 'status']); // API-120
        Route::post('/test-database', [SetupController::class, 'testDatabase']); // API-121
        Route::post('/test-redis', [SetupController::class, 'testRedis']); // API-122
        Route::post('/install', [SetupController::class, 'install'])->middleware('throttle:setup-install'); // API-123
    });
});
