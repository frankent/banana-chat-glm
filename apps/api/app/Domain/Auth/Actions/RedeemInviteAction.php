<?php

namespace App\Domain\Auth\Actions;

use App\Domain\Auth\PasswordPolicy;
use App\Enums\UserStatus;
use App\Events\WorkspaceMembershipChanged;
use App\Exceptions\ApiException;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceInvite;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * FR-AUTH-008 / FR-WS-006 / DEC-081 — redeem a one-time workspace invite:
 * create the account, join the workspace as `role=member`, burn the token,
 * log the invitee straight in. `preview()` is read-many (a person may open
 * the link/QR several times before submitting); `execute()` is the single
 * atomic claim.
 */
class RedeemInviteAction
{
    public function __construct(
        private readonly PasswordPolicy $passwordPolicy,
        private readonly AuditLogger $audit,
        private readonly LoginAction $loginAction,
    ) {}

    public function preview(string $token): Workspace
    {
        return $this->resolve($token)->workspace;
    }

    /**
     * @param  array{platform?: string, name?: string, app_version?: string}  $deviceInfo
     * @return array{user: User, session: \App\Models\ChatSession, access_token: string, expires_in: int, refresh_token: string}
     */
    public function execute(string $token, string $username, string $password, string $displayName, array $deviceInfo, ?Request $request = null, string $locale = 'th'): array
    {
        $username = trim($username);
        $tokenHash = hash('sha256', $token);

        // Fast, friendly check before we touch a row lock — the real
        // exactly-once guarantee is the re-check inside the transaction below.
        $this->resolve($token);

        $this->passwordPolicy->assertValid($password, $username);

        if (User::query()->where('username', $username)->exists()) {
            throw ApiException::usernameTaken();
        }

        [$invite, $user] = DB::transaction(function () use ($tokenHash, $username, $password, $displayName, $locale) {
            /** @var WorkspaceInvite $invite */
            $invite = WorkspaceInvite::query()->where('token_hash', $tokenHash)->lockForUpdate()->firstOrFail();
            $this->assertConsumable($invite);

            try {
                $user = User::query()->create([
                    'username' => $username,
                    'password_hash' => Hash::make($password),
                    'display_name' => $displayName,
                    // FR-AUTH-008 — matches whatever locale the join page was
                    // rendered in (browser-detected, since there's no signed-in
                    // user yet to read a stored preference from).
                    'locale' => $locale,
                    'status' => UserStatus::Active,
                    'must_change_password' => false, // the invitee chose this password themselves
                    'created_by' => $invite->created_by,
                ]);
            } catch (QueryException $e) {
                if ((string) $e->getCode() === '23505') {
                    throw ApiException::usernameTaken();
                }

                throw $e;
            }

            $membership = WorkspaceMember::query()->create([
                'workspace_id' => $invite->workspace_id,
                'user_id' => $user->id,
                'role' => 'member',
                'status' => 'active',
                'invited_by' => $invite->created_by,
            ]);

            $invite->update(['used_at' => now(), 'used_by' => $user->id]);

            $this->audit->log('workspace.member_added', $user, 'workspace', $invite->workspace_id, ['user_id' => $user->id, 'role' => 'member'], $invite->workspace_id);
            $this->audit->log('auth.registered_via_invite', $user, 'workspace_invite', $invite->id, [
                'workspace_id' => $invite->workspace_id,
                'invited_by' => $invite->created_by,
            ], $invite->workspace_id);
            DB::afterCommit(fn () => broadcast(new WorkspaceMembershipChanged($membership, 'workspace.member_added')));

            return [$invite, $user];
        });

        return $this->loginAction->establishSession($user, $deviceInfo, $request);
    }

    private function resolve(string $token): WorkspaceInvite
    {
        $invite = WorkspaceInvite::query()->where('token_hash', hash('sha256', $token))->with('workspace')->first();

        if ($invite === null) {
            throw ApiException::inviteNotFound();
        }

        $this->assertConsumable($invite);

        return $invite;
    }

    private function assertConsumable(WorkspaceInvite $invite): void
    {
        if ($invite->revoked_at !== null) {
            throw ApiException::inviteRevoked();
        }

        if ($invite->used_at !== null) {
            throw ApiException::inviteAlreadyUsed();
        }

        if ($invite->expires_at->isPast()) {
            throw ApiException::inviteExpired();
        }
    }
}
