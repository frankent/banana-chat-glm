<?php

use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\HealthController;
use App\Http\Controllers\Api\V1\MeController;
use App\Http\Controllers\Api\V1\MessageController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\RoomController;
use App\Http\Controllers\Api\V1\UploadController;
use App\Http\Controllers\Api\V1\WorkspaceController;
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
    });

    // Workspace-scoped routes — X-Workspace-Id required (FR-WS-003 isolation)
    Route::middleware(['auth:api', 'account.active', 'password.fresh', 'workspace.context'])->group(function (): void {
        Route::get('/workspace', [WorkspaceController::class, 'show']);
        Route::get('/members', [WorkspaceController::class, 'members']);
        Route::get('/sync', [WorkspaceController::class, 'sync']);
        Route::get('/me/mentions', [MeController::class, 'mentions']); // API-044 (auth ws)

        // Room params resolve inside the controller (RoomController::roomOrFail):
        // SubstituteBindings runs before workspace.context sets the scope, so
        // implicit binding here would leak cross-workspace rooms.

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
    Route::prefix('v1')->middleware('signed')->group(function (): void {
        Route::put('/uploads/{attachment}/binary', [UploadController::class, 'binary'])
            ->whereUlid('attachment')->name('uploads.binary');
        Route::get('/attachments/{attachment}/file/{variant}', [UploadController::class, 'file'])
            ->whereUlid('attachment')
            ->whereIn('variant', ['original', 'thumb_sm', 'thumb_md', 'poster'])
            ->name('attachments.file');
    });

    Route::get('/health', [HealthController::class, 'index']);
});
