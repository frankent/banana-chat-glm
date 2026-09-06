<?php

namespace App\Domain\Auth\Actions;

use App\Domain\Auth\PasswordPolicy;
use App\Domain\Auth\TokenService;
use App\Exceptions\ApiException;
use App\Models\ChatSession;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

/**
 * FR-AUTH-004 — change password, revoke all other sessions, keep current.
 */
class ChangePasswordAction
{
    public function __construct(
        private readonly PasswordPolicy $policy,
        private readonly TokenService $tokens,
        private readonly AuditLogger $audit,
    ) {}

    public function execute(User $user, ChatSession $currentSession, string $currentPassword, string $newPassword, ?Request $request = null): void
    {
        if (! Hash::check($currentPassword, $user->password_hash)) {
            throw new ApiException('AUTH_CURRENT_PASSWORD_WRONG', 'รหัสผ่านปัจจุบันไม่ถูกต้อง', 422);
        }

        if (Hash::check($newPassword, $user->password_hash)) {
            throw new ApiException('AUTH_PASSWORD_REUSED', 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน', 422);
        }

        $this->policy->assertValid($newPassword, $user->username);

        $user->forceFill([
            'password_hash' => Hash::make($newPassword),
            'must_change_password' => false,
            'password_changed_at' => now(),
        ])->save();

        // Kill every other session (their devices get session.revoked)
        $others = ChatSession::query()
            ->where('user_id', $user->id)
            ->whereKeyNot($currentSession->id)
            ->whereNull('revoked_at')
            ->get();

        foreach ($others as $other) {
            $this->tokens->revokeSession($other, 'password_change');
        }

        $this->audit->log('auth.password_changed', $user, 'user', $user->id, [
            'revoked_sessions' => $others->count(),
        ], null, $request);
    }
}
