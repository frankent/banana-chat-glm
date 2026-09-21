<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Auth\Actions\RedeemInviteAction;
use App\Domain\Workspace\WorkspaceSummaryBuilder;
use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * API-232/233, FR-AUTH-008 — PUBLIC, unauthenticated. The token is the only
 * credential; see RedeemInviteAction for the single-use guarantee.
 */
class InviteRedemptionController extends Controller
{
    public function show(string $token, RedeemInviteAction $action): JsonResponse
    {
        $workspace = $action->preview($token);

        return response()->json([
            'data' => ['workspace' => ['name' => $workspace->name]],
        ]);
    }

    public function store(Request $request, string $token, RedeemInviteAction $action): JsonResponse
    {
        $data = $request->validate([
            // PRODUCT_SPEC.md:300 — 3-32 lowercase [a-z0-9._-]. Every OTHER
            // account-creation path in this codebase (AuthController::login's
            // own validation, SetupController's first admin, the Filament
            // user form) has never actually enforced this; a brand-new public
            // registration surface doesn't inherit that leniency by default.
            'username' => ['required', 'string', 'regex:/^[a-z0-9._-]{3,32}$/'],
            'password' => ['required', 'string', 'max:256'],
            'display_name' => ['required', 'string', 'max:80'],
            'locale' => ['nullable', 'string', 'in:th,en'],
            'device' => ['nullable', 'array'],
            'device.platform' => ['nullable', 'string', 'max:10'],
            'device.name' => ['nullable', 'string', 'max:100'],
            'device.app_version' => ['nullable', 'string', 'max:20'],
        ]);

        $result = $action->execute(
            $token,
            $data['username'],
            $data['password'],
            $data['display_name'],
            $data['device'] ?? [],
            $request,
            $data['locale'] ?? 'th',
        );

        $user = $result['user'];

        return response()->json([
            'access_token' => $result['access_token'],
            'expires_in' => $result['expires_in'],
            'refresh_token' => $result['refresh_token'],
            'user' => new UserResource($user),
            'workspaces' => app(WorkspaceSummaryBuilder::class)->forUser($user),
            'must_change_password' => $user->must_change_password,
        ], 201);
    }
}
