<?php

namespace App\Domain\Ai;

use App\Models\AiProvider;
use App\Models\User;
use App\Services\SettingsService;

/**
 * §8.9 [ai] guard chain: ai.enabled → default provider exists →
 * workspace allowed → user consented. Returns the provider or the
 * spec error code for the 403/503 response.
 */
class AiGate
{
    public function __construct(private readonly SettingsService $settings) {}

    /**
     * @return array{0: ?AiProvider, 1: ?string} provider or error code
     */
    public function resolve(string $userId, ?string $workspaceId, bool $requireConsent = true): array
    {
        if (! $this->settings->bool('ai.enabled')) {
            return [null, 'AI_DISABLED']; // 403
        }

        $provider = AiProvider::defaultProvider();
        if ($provider === null) {
            return [null, 'AI_PROVIDER_NOT_CONFIGURED']; // 503
        }

        if ($workspaceId !== null && ! $provider->allowsWorkspace($workspaceId)) {
            return [null, 'AI_WORKSPACE_NOT_ALLOWED']; // 403
        }

        if ($requireConsent) {
            $consented = User::query()->whereKey($userId)->value('ai_consented_at');
            if ($consented === null) {
                return [null, 'AI_CONSENT_REQUIRED']; // 403
            }
        }

        return [$provider, null];
    }
}
