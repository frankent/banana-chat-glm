<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Workspace\WorkspaceInviteService;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\WorkspaceInvite;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/** API-230/231, FR-WS-006 — owner/admin issues/revokes a one-time invite QR/link. */
class WorkspaceInviteController extends Controller
{
    public function __construct(
        private readonly WorkspaceContext $context,
    ) {}

    public function store(Request $request, WorkspaceInviteService $service): JsonResponse
    {
        ['invite' => $invite, 'token' => $token] = $service->issue($request->user(), $this->context->workspace());

        return response()->json([
            'data' => [
                'id' => $invite->id,
                'token' => $token,
                'join_url' => rtrim((string) config('app.url'), '/').'/join/'.$token,
                'expires_at' => $invite->expires_at->toIso8601String(),
            ],
        ], 201);
    }

    public function destroy(Request $request, string $id, WorkspaceInviteService $service): Response
    {
        $invite = WorkspaceInvite::query()
            ->where('workspace_id', $this->context->id())
            ->where('id', $id)
            ->first();

        if ($invite === null) {
            throw ApiException::inviteNotFound();
        }

        $service->revoke($request->user(), $invite);

        return response()->noContent();
    }
}
