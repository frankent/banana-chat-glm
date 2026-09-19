<?php

namespace App\Domain\Auth\Actions;

use App\Domain\Auth\TokenService;
use App\Exceptions\ApiException;
use App\Models\ChatSession;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;

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
            $this->detectReuseOrFail($hash);
        }

        if ($session->revoked_at !== null) {
            throw ApiException::tokenInvalid();
        }

        if ($session->expires_at->isPast()) {
            throw ApiException::refreshExpired();
        }

        $rotated = $this->tokens->rotateRefreshToken($session, $hash);

        if ($rotated === null) {
            // R5 — lost the race: another request already consumed $hash.
            // Its own replay is now indistinguishable from theft (the token
            // it holds is a rotated-out predecessor), which is the correct,
            // spec-literal answer (FR-AUTH-002 AC) rather than a silent retry.
            $this->detectReuseOrFail($hash);
        }

        $access = $this->tokens->issueAccessToken($session->refresh());

        return [
            'session' => $session,
            'access_token' => $access['token'],
            'expires_in' => $this->settings->int('auth.access_token_ttl_minutes') * 60,
            'refresh_token' => $rotated['token'],
        ];
    }

    /**
     * Reuse detection over the FULL rotation lineage (R6), not just the
     * immediate predecessor. `revokeSession`/`audit->log` run outside any
     * transaction on purpose: nesting them inside one that then throws would
     * roll the revocation and audit row back with it (R5 trap).
     */
    private function detectReuseOrFail(string $hash): never
    {
        $lineage = DB::table('refresh_token_lineage')->where('token_hash', $hash)->first();

        if ($lineage !== null) {
            $reused = ChatSession::query()->find($lineage->session_id);

            if ($reused !== null) {
                $this->tokens->revokeSession($reused, 'rotation');
                $this->audit->log('auth.refresh_reuse_detected', $reused->user, 'session', $reused->id, [
                    'action_taken' => 'session_revoked',
                ]);
            }

            throw ApiException::refreshReused();
        }

        throw ApiException::tokenInvalid();
    }
}
