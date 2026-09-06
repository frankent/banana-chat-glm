<?php

namespace App\Domain\Auth\Actions;

use App\Domain\Auth\TokenService;
use App\Exceptions\ApiException;
use App\Models\ChatSession;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

/**
 * FR-AUTH-001/006 — login with anti-enumeration, lockout, session/device rows,
 * max-session eviction with session.revoked broadcast, audit.
 */
class LoginAction
{
    /**
     * Pre-computed hash of a random password — used to equalize timing when the
     * username does not exist (TC-AUTH-004).
     */
    private const DUMMY_HASH = '$2y$12$K0t1Q3vJ8xYw2mZ5nB7rAeO9uT4pQ6wE1sD3fG5hJ7kL9mN1bV3cq';

    public function __construct(
        private readonly TokenService $tokens,
        private readonly SettingsService $settings,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array{platform?: string, name?: string, app_version?: string}  $deviceInfo
     * @return array{user: User, session: ChatSession, access_token: string, expires_in: int, refresh_token: string}
     */
    public function execute(string $username, string $password, array $deviceInfo, ?Request $request = null): array
    {
        $username = trim($username);

        /** @var User|null $user */
        $user = User::query()->where('username', $username)->first();

        if ($user === null) {
            // Burn equivalent CPU so response time doesn't leak username existence.
            Hash::check($password, self::DUMMY_HASH);

            throw ApiException::invalidCredentials();
        }

        if ($user->locked_until !== null && $user->locked_until->isFuture()) {
            throw ApiException::locked((int) ceil(now()->diffInSeconds($user->locked_until, false)));
        }

        if (! in_array($user->status->value, ['active'], true)) {
            // suspended or deactivated — same message either way (anti-enum)
            throw ApiException::accountDisabled();
        }

        if (! Hash::check($password, $user->password_hash)) {
            $this->recordFailure($user);

            throw ApiException::invalidCredentials();
        }

        // Argon2id auto-rehash if cost params changed (FR-AUTH-005)
        if (Hash::needsRehash($user->password_hash)) {
            $user->forceFill(['password_hash' => Hash::make($password)])->save();
        }

        return $this->establishSession($user, $deviceInfo, $request);
    }

    /**
     * @param  array{platform?: string, name?: string, app_version?: string}  $deviceInfo
     * @return array{user: User, session: ChatSession, access_token: string, expires_in: int, refresh_token: string}
     */
    public function establishSession(User $user, array $deviceInfo, ?Request $request = null): array
    {
        $user->forceFill([
            'failed_login_count' => 0,
            'last_seen_at' => now(),
        ])->save();

        $device = $this->tokens->upsertDevice($user, $deviceInfo);

        $refresh = $this->tokens->newRefreshTokenValue();

        $session = ChatSession::create([
            'user_id' => $user->id,
            'refresh_token_hash' => $refresh['hash'],
            'device_id' => $device->id,
            'ip' => $request?->ip(),
            'user_agent' => $request ? mb_substr((string) $request->userAgent(), 0, 1000) : null,
            'last_used_at' => now(),
            'expires_at' => $refresh['expires_at'],
        ]);

        $this->evictOverflowSessions($user, $session);

        $access = $this->tokens->issueAccessToken($session);

        $this->audit->log('auth.login', $user, 'session', $session->id, [
            'device_id' => $device->id,
            'platform' => $device->platform->value,
        ], null, $request);

        return [
            'user' => $user,
            'session' => $session,
            'access_token' => $access['token'],
            'expires_in' => $this->settings->int('auth.access_token_ttl_minutes') * 60,
            'refresh_token' => $refresh['token'],
        ];
    }

    private function recordFailure(User $user): void
    {
        $count = $user->failed_login_count + 1;
        $threshold = $this->settings->int('auth.lockout.threshold');

        $user->forceFill(['failed_login_count' => $count])->save();

        if ($count >= $threshold) {
            $user->forceFill([
                'locked_until' => now()->addMinutes($this->settings->int('auth.lockout.minutes')),
                'failed_login_count' => 0,
            ])->save();
        }
    }

    /**
     * max_sessions_per_user: revoke the least-recently-used other session and
     * notify that device via session.revoked (FR-AUTH-001 edge).
     */
    private function evictOverflowSessions(User $user, ChatSession $except): void
    {
        $max = $this->settings->int('auth.max_sessions_per_user');

        $overflow = ChatSession::query()
            ->where('user_id', $user->id)
            ->whereKeyNot($except->id)
            ->whereNull('revoked_at')
            ->where('expires_at', '>', now())
            ->orderByDesc('last_used_at')
            ->skip(max(0, $max - 1))
            ->get();

        foreach ($overflow as $old) {
            $this->tokens->revokeSession($old, 'rotation');
        }
    }
}
