<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Workspace\WorkspaceSummaryBuilder;
use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * API-008/009/010 — /me, /me/workspaces.
 */
class MeController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return response()->json([
            'data' => [
                'user' => new UserResource($user),
                'settings' => [
                    'locale' => $user->locale,
                    'timezone' => $user->timezone,
                    'notification' => $user->notificationSetting?->only(['dnd_start', 'dnd_end', 'dnd_days', 'sound', 'preview_in_push']),
                ],
            ],
        ]);
    }

    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'display_name' => ['sometimes', 'string', 'min:1', 'max:80'],
            'locale' => ['sometimes', 'string', 'in:th,en'],
            'timezone' => ['sometimes', 'string', 'timezone', 'max:64'],
            'avatar_attachment_id' => ['sometimes', 'nullable', 'ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();
        $user->fill($data)->save();

        return response()->json(['data' => ['user' => new UserResource($user->refresh())]]);
    }

    public function workspaces(Request $request, WorkspaceSummaryBuilder $builder): JsonResponse
    {
        return response()->json([
            'data' => $builder->forUser($request->user()),
        ]);
    }
}
