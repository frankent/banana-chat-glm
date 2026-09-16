<?php

namespace App\Domain\PublicChat;

use App\Exceptions\ApiException;
use App\Services\SettingsService;

/**
 * FR-PCHAT-033/034 · DEC-067/071 — the kill switch.
 *
 * THE GATE IS DELIBERATELY NOT IN VerifyPublicChatSignature. Verification order
 * is fail-closed and cheapest-first, and the feature check runs LAST (step 7),
 * inside the controller, for two reasons that both matter:
 *   - an unauthenticated prober must not learn whether the feature is on, and
 *   - a legitimate partner whose signature verified must get a clean, retriable
 *     503 PCHAT_DISABLED (with Retry-After: 60) rather than a misleading 401.
 *
 * FEATURE-OFF SEMANTICS ARE ASYMMETRIC ON PURPOSE (DEC-067): WRITES STOP, READS
 * AND DATA SURVIVE. Call assertEnabled() on write paths ONLY —
 *   Tier 1: API-200 create, API-202 close, API-203 rotate-link
 *   Tier 2: API-212 send, API-213/214 upload, API-216 typing
 *   Tier 3: API-223 send, API-224 patch, API-225 upload, API-226 delete
 * and NEVER on API-201, 210, 211, 215, 220, 221, 222, 227, 228. A visitor GET
 * answers 200 with feature_enabled:false / can_send:false so the page shows a
 * calm "support is temporarily unavailable" banner over a still-readable
 * transcript instead of an error page, and the Filament transcript stays
 * readable precisely when an admin has switched the feature off.
 *
 * Existing conversations are never closed, expired, reassigned or deleted by a
 * disable: status, assigned_to and every message are preserved exactly, and
 * re-enabling resumes mid-conversation with no migration.
 */
class PublicChatGate
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * DEC-071 — ships DISABLED. The default lives in SettingsService::DEFAULTS
     * as `publicchat.enabled => false`; the fallback here is false as well so a
     * missing key can never fail open on an externally reachable surface.
     */
    public function enabled(): bool
    {
        return (bool) $this->settings->get('publicchat.enabled', false);
    }

    /** Write paths only — see the class docblock for the exact endpoint list. */
    public function assertEnabled(): void
    {
        if (! $this->enabled()) {
            throw ApiException::pchatDisabled();
        }
    }

    /**
     * FR-PCHAT-012 — link lifetime in days.
     *
     * Read through get() with an explicit fallback, NOT $settings->int(): until
     * `publicchat.link_ttl_days` lands in SettingsService::DEFAULTS (it needs a
     * matching Settings::ranges() entry or the whole admin settings page throws)
     * int() returns 0, which would set expires_at = now() and 410 every link the
     * instant it was created. This shape is correct both before and after that
     * key lands.
     */
    public function linkTtlDays(): int
    {
        return max(1, (int) $this->settings->get('publicchat.link_ttl_days', 30));
    }

    /** FR-PCHAT-033 — same "correct before and after the key lands" rule. */
    public function maxMessageLength(): int
    {
        return max(1, (int) $this->settings->get('publicchat.max_message_length', 4000));
    }
}
