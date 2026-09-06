<?php

namespace App\Domain\Auth\Actions;

use App\Domain\Auth\TokenService;
use App\Exceptions\ApiException;
use App\Models\ChatSession;
use App\Services\AuditLogger;
use App\Services\SettingsService;

/**
 * FR-AUTH-002 — rotating refresh with reuse (theft) detection.
 */
class RefreshAction
{
    public function __construct(
        private readonly TokenService $tokens,
        private readonly SettingsService $settings,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @return array{session: ChatSession, access_token: string, expires_in: int, refresh_token: string}
     */
    public function execute(string $refreshToken): array
    {
        $hash = hash('sha256', $refreshToken);

        $session = ChatSession::query()->where('refresh_token_hash', $hash)->first();

        if ($session === null) {
            // Reuse detection: token matches a rotated-out predecessor → theft.
            $reused = ChatSession::query()->where('prev_refresh_token_hash', $hash)->first();

            if ($reused !== null) {
                $this->tokens->revokeSession($reused, 'rotation');
                $this->audit->log('auth.refresh_reuse_detected', $reused->user, 'session', $reused->id, [
                    'action_taken' => 'session_revoked',
                ]);

                throw ApiException::refreshReused();
            }

            throw ApiException::tokenInvalid();
        }

        if ($session->revoked_at !== null) {
            throw ApiException::tokenInvalid();
        }

        if ($session->expires_at->isPast()) {
            throw ApiException::refreshExpired();
        }

        $rotated = $this->tokens->rotateRefreshToken($session);
        $access = $this->tokens->issueAccessToken($session->refresh());

        return [
            'session' => $session,
            'access_token' => $access['token'],
            'expires_in' => $this->settings->int('auth.access_token_ttl_minutes') * 60,
            'refresh_token' => $rotated['token'],
        ];
    }
}
