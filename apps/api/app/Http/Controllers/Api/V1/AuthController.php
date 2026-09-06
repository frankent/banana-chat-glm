<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Auth\Actions\ChangePasswordAction;
use App\Domain\Auth\Actions\LoginAction;
use App\Domain\Auth\Actions\RefreshAction;
use App\Domain\Auth\TokenService;
use App\Domain\Workspace\WorkspaceSummaryBuilder;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Http\Resources\SessionResource;
use App\Http\Resources\UserResource;
use App\Models\ChatSession;
use App\Services\AuditLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Http\Response;

class AuthController extends Controller
{
    public function login(Request $request, LoginAction $action): JsonResponse
    {
        $credentials = $request->validate([
            'username' => ['required', 'string', 'max:64'],
            'password' => ['required', 'string', 'max:256'],
            'device' => ['nullable', 'array'],
            'device.platform' => ['nullable', 'string', 'max:10'],
            'device.name' => ['nullable', 'string', 'max:100'],
            'device.app_version' => ['nullable', 'string', 'max:20'],
        ]);

        $result = $action->execute(
            $credentials['username'],
            $credentials['password'],
            $credentials['device'] ?? [],
            $request,
        );

        $user = $result['user'];

        return response()->json([
            'access_token' => $result['access_token'],
            'expires_in' => $result['expires_in'],
            'refresh_token' => $result['refresh_token'],
            'user' => new UserResource($user),
            'workspaces' => app(WorkspaceSummaryBuilder::class)->forUser($user),
            'must_change_password' => $user->must_change_password,
        ]);
    }

    public function refresh(Request $request, RefreshAction $action): JsonResponse
    {
        $data = $request->validate([
            'refresh_token' => ['required', 'string'],
        ]);

        $result = $action->execute($data['refresh_token']);

        return response()->json([
            'access_token' => $result['access_token'],
            'expires_in' => $result['expires_in'],
            'refresh_token' => $result['refresh_token'],
        ]);
    }

    public function logout(Request $request, TokenService $tokens): Response
    {
        $session = $request->attributes->get('chat_session');

        if ($session instanceof ChatSession) {
            // Drop this device's push token (FR-AUTH-003)
            $session->device?->forceFill(['push_token' => null])->save();
            $tokens->revokeSession($session, 'logout', broadcast: false);
        }

        return response()->noContent();
    }

    public function logoutAll(Request $request, TokenService $tokens): Response
    {
        $current = $request->attributes->get('chat_session');

        ChatSession::query()
            ->where('user_id', $request->user()->id)
            ->whereNull('revoked_at')
            ->get()
            ->each(fn (ChatSession $s) => $tokens->revokeSession(
                $s,
                'logout',
                broadcast: ! ($current instanceof ChatSession && $s->id === $current->id),
            ));

        return response()->noContent();
    }

    public function changePassword(Request $request, ChangePasswordAction $action): Response
    {
        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'new_password' => ['required', 'string', 'max:256'],
        ]);

        $session = $request->attributes->get('chat_session');

        if (! $session instanceof ChatSession) {
            throw ApiException::tokenInvalid();
        }

        $action->execute($request->user(), $session, $data['current_password'], $data['new_password'], $request);

        return response()->noContent();
    }

    public function sessions(Request $request): AnonymousResourceCollection
    {
        $currentId = $request->attributes->get('chat_session')?->id;

        $sessions = ChatSession::query()
            ->where('user_id', $request->user()->id)
            ->whereNull('revoked_at')
            ->where('expires_at', '>', now())
            ->with('device')
            ->orderByDesc('last_used_at')
            ->get();

        return SessionResource::collection(
            $sessions->map(fn (ChatSession $s) => $s->setAttribute('is_current', $s->id === $currentId))
        );
    }

    public function revokeSession(Request $request, string $sessionId, TokenService $tokens, AuditLogger $audit): Response
    {
        $session = ChatSession::query()
            ->where('user_id', $request->user()->id)
            ->whereKey($sessionId)
            ->whereNull('revoked_at')
            ->firstOrFail();

        if ($session->id === $request->attributes->get('chat_session')?->id) {
            throw new ApiException('VALIDATION_FAILED', 'ไม่สามารถ revoke session ปัจจุบันได้ ใช้ logout', 422, [
                'fields' => ['session_id' => ['use /auth/logout for the current session']],
            ]);
        }

        $tokens->revokeSession($session, 'remote-logout');
        $audit->log('auth.session_revoked', $request->user(), 'session', $session->id, [], null, $request);

        return response()->noContent();
    }
}
