<?php

namespace App\Domain\Workspace;

use App\Enums\WorkspaceRole;
use App\Exceptions\ApiException;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceInvite;
use App\Support\WorkspaceContext;
use Illuminate\Support\Facades\DB;

/**
 * FR-WS-006 / DEC-081 — owner/admin issues a one-time-use, 24h-expiring
 * invite token; the token itself is only ever returned once, at issue time.
 */
class WorkspaceInviteService
{
    private const TTL_HOURS = 24;

    public function __construct(
        private readonly WorkspaceContext $context,
    ) {}

    /**
     * @return array{invite: WorkspaceInvite, token: string}
     */
    public function issue(User $actor, Workspace $workspace): array
    {
        $this->assertWsAdmin($actor);

        // 64 lowercase hex chars — must satisfy the route's [a-f0-9]{64}
        // constraint (Str::random() is alphanumeric mixed-case, not hex).
        $token = bin2hex(random_bytes(32));

        $invite = WorkspaceInvite::query()->create([
            'workspace_id' => $workspace->id,
            'created_by' => $actor->id,
            'token_hash' => hash('sha256', $token),
            'expires_at' => now()->addHours(self::TTL_HOURS),
        ]);

        return ['invite' => $invite, 'token' => $token];
    }

    public function revoke(User $actor, WorkspaceInvite $invite): void
    {
        $this->assertWsAdmin($actor);

        if ($invite->workspace_id !== $this->context->id()) {
            throw ApiException::inviteNotFound();
        }

        DB::transaction(function () use ($invite) {
            $locked = WorkspaceInvite::query()->lockForUpdate()->findOrFail($invite->id);
            if ($locked->revoked_at === null && $locked->used_at === null) {
                $locked->update(['revoked_at' => now()]);
            }
        });
    }

    private function assertWsAdmin(User $actor): void
    {
        $rank = $this->context->membership()?->role?->rank() ?? 0;

        if (! $actor->is_system_admin && $rank < WorkspaceRole::Admin->rank()) {
            throw new ApiException('WS_FORBIDDEN', 'คุณไม่มีสิทธิ์สร้างคำเชิญของ workspace นี้', 403);
        }
    }
}
