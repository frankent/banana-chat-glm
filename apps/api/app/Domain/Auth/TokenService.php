<?php

namespace App\Domain\Auth;

use App\Events\SessionRevoked;
use App\Exceptions\ApiException;
use App\Models\AccessToken;
use App\Models\ChatSession;
use App\Models\Device;
use App\Models\InAppNotification;
use App\Models\User;
use App\Services\SettingsService;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Opaque bearer tokens (D3, no Sanctum). Access = sha256-hashed random 64 hex
 * with short TTL; refresh = sha256-hashed random with 30d rolling TTL.
 */
class TokenService
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * @return array{token: string, hash: string, expires_at: CarbonInterface}
     */
    public function issueAccessToken(ChatSession $session): array
    {
        $token = Str::random(64);
        $expiresAt = now()->addMinutes($this->settings->int('auth.access_token_ttl_minutes'));

        AccessToken::create([
            'user_id' => $session->user_id,
            'session_id' => $session->id,
            'token_hash' => hash('sha256', $token),
            'expires_at' => $expiresAt,
        ]);

        return ['token' => $token, 'hash' => hash('sha256', $token), 'expires_at' => $expiresAt];
    }

    /**
     * @return array{token: string, hash: string, expires_at: CarbonInterface}
     */
    public function newRefreshTokenValue(): array
    {
        $token = Str::random(64);
        $expiresAt = now()->addDays($this->settings->int('auth.refresh_token_ttl_days'));

        return ['token' => $token, 'hash' => hash('sha256', $token), 'expires_at' => $expiresAt];
    }

    /**
     * Resolve a bearer token to an active user + session. Null when invalid/expired.
     *
     * @return array{user: User, session: ChatSession, accessToken: AccessToken}|null
     */
    public function resolveAccessToken(string $bearerToken): ?array
    {
        $accessToken = AccessToken::query()
            ->where('token_hash', hash('sha256', $bearerToken))
            ->whereNull('revoked_at')
            ->first();

        if ($accessToken === null) {
            return null;
        }

        if ($accessToken->expires_at->isPast()) {
            throw ApiException::tokenExpired();
        }

        $session = ChatSession::query()
            ->whereKey($accessToken->session_id)
            ->whereNull('revoked_at')
            ->first();

        if ($session === null || $session->isExpired()) {
            return null;
        }

        $user = User::query()->find($session->user_id);

        if ($user === null) {
            return null;
        }

        return ['user' => $user, 'session' => $session, 'accessToken' => $accessToken];
    }

    /**
     * Rotate: revoke old refresh lineage, issue a new one, roll expires_at.
     *
     * @return array{token: string, expires_at: CarbonInterface}
     */
    public function rotateRefreshToken(ChatSession $session): array
    {
        $next = $this->newRefreshTokenValue();

        $session->fill([
            'prev_refresh_token_hash' => $session->refresh_token_hash,
            'refresh_token_hash' => $next['hash'],
            'expires_at' => $next['expires_at'], // rolling 30d
            'last_used_at' => now(),
        ])->save();

        return ['token' => $next['token'], 'expires_at' => $next['expires_at']];
    }

    public function revokeSession(ChatSession $session, string $reason, bool $broadcast = true): void
    {
        if ($session->revoked_at !== null) {
            return;
        }

        DB::transaction(function () use ($session, $reason) {
            $session->fill(['revoked_at' => now(), 'revoked_reason' => $reason])->save();
            $session->accessTokens()->update(['revoked_at' => now()]);

            // FR-NOTI-006 — a security row in the notification center. A
            // routine self-logout is not security-relevant, everything else
            // ("admin", "password_changed", …) is.
            if ($reason !== 'logout') {
                InAppNotification::query()->create([
                    'user_id' => $session->user_id,
                    'workspace_id' => null, // account-level event
                    'type' => 'session_revoked',
                    'room_id' => null,
                    'actor_id' => null,
                    'data' => ['session_id' => $session->id, 'reason' => $reason],
                ]);
            }
        });

        if ($broadcast) {
            broadcast(new SessionRevoked($session->user_id, $session->id, $reason))->toOthers();
        }
    }

    /**
     * Find or create the device row for a login request.
     */
    public function upsertDevice(User $user, array $deviceInfo): Device
    {
        $platform = $deviceInfo['platform'] ?? 'web';

        if (! in_array($platform, ['web', 'ios', 'android'], true)) {
            $platform = 'web';
        }

        return Device::updateOrCreate(
            [
                'user_id' => $user->id,
                'platform' => $platform,
                'device_name' => mb_substr($deviceInfo['name'] ?? 'Unknown device', 0, 100),
            ],
            [
                'app_version' => $deviceInfo['app_version'] ?? null,
                'last_active_at' => now(),
            ],
        );
    }
}
