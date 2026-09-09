<?php

namespace App\Domain\Admin;

use App\Enums\UserStatus;
use App\Models\ChatSession;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * FR-ADM-002/003/004 — admin operations on users. Domain logic lives here so
 * Filament actions and Feature tests exercise the same path.
 */
class AdminUserService
{
    public function __construct(
        private readonly AuditLogger $audit,
    ) {}

    /**
     * FR-ADM-002 — create user with a one-time temp password (never stored plaintext).
     *
     * @param  array{workspaces?: array<int, array{workspace_id: string, role: string}>}  $workspaces
     * @return array{0: User, 1: string} [user, temp_password]
     */
    public function createUser(User $actor, string $username, string $displayName, ?string $locale = 'th', array $workspaces = [], bool $systemAdmin = false): array
    {
        $tempPassword = 'Tmp-'.Str::random(12);

        $user = User::query()->create([
            'username' => $username,
            'password_hash' => Hash::make($tempPassword),
            'display_name' => $displayName,
            'locale' => $locale ?? 'th',
            'status' => UserStatus::Active,
            'must_change_password' => true,
            'is_system_admin' => $systemAdmin,
            'created_by' => $actor->id,
        ]);

        foreach ($workspaces as $assignment) {
            WorkspaceMember::query()->create([
                'workspace_id' => $assignment['workspace_id'],
                'user_id' => $user->id,
                'role' => $assignment['role'],
                'status' => 'active',
                'invited_by' => $actor->id,
            ]);
        }

        $this->audit->log('user.created', $actor, 'user', $user->id, ['username' => $user->username, 'workspaces' => count($workspaces)]);

        return [$user, $tempPassword];
    }

    /**
     * FR-ADM-003 — suspend: revoke every API session immediately, block login.
     */
    public function suspend(User $actor, User $target): void
    {
        $target->forceFill(['status' => UserStatus::Suspended])->save();
        $this->revokeAllSessions($target);

        $this->audit->log('user.suspended', $actor, 'user', $target->id);
    }

    public function unsuspend(User $actor, User $target): void
    {
        $target->forceFill(['status' => UserStatus::Active])->save();

        $this->audit->log('user.unsuspended', $actor, 'user', $target->id);
    }

    /**
     * FR-ADM-003 — deactivate (permanent): revoke sessions, mark ws memberships
     * removed, leave all rooms. PH1 scope — member_deactivated system messages
     * deferred (spec deviation, see §16).
     */
    public function deactivate(User $actor, User $target): void
    {
        $target->forceFill(['status' => UserStatus::Deactivated])->save();
        $this->revokeAllSessions($target);

        WorkspaceMember::query()
            ->where('user_id', $target->id)
            ->where('status', 'active')
            ->update(['status' => 'removed', 'removed_at' => now()]);

        RoomMember::query()
            ->where('user_id', $target->id)
            ->whereNull('left_at')
            ->update(['left_at' => now()]);

        $this->audit->log('user.deactivated', $actor, 'user', $target->id);
    }

    /**
     * FR-ADM-004 — reset password: fresh temp (shown once), force change, revoke sessions.
     *
     * @return string temp password
     */
    public function resetPassword(User $actor, User $target): string
    {
        $tempPassword = 'Tmp-'.Str::random(12);

        $target->forceFill([
            'password_hash' => Hash::make($tempPassword),
            'must_change_password' => true,
            'password_changed_at' => null,
        ])->save();

        $this->revokeAllSessions($target);

        $this->audit->log('user.password_reset', $actor, 'user', $target->id);

        return $tempPassword;
    }

    /**
     * FR-ADM-004 — unlock after lockout.
     */
    public function unlock(User $actor, User $target): void
    {
        $target->forceFill(['locked_until' => null, 'failed_login_count' => 0])->save();

        $this->audit->log('user.unlocked', $actor, 'user', $target->id);
    }

    /**
     * Kill every live API session (access tokens cascade via FK).
     */
    public function revokeAllSessions(User $target): int
    {
        return ChatSession::query()->where('user_id', $target->id)->whereNull('revoked_at')->delete();
    }
}
