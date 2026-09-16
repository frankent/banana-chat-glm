<?php

namespace App\Domain\Calls;

use App\Services\SettingsService;

/**
 * FR-CALL-006 / DEC-057 — admin-adjustable group capacity (default 8, range 2–50).
 *
 * Read once when a group call starts or a meeting link is created; the value is
 * persisted as that call/link's capacity snapshot. LiveKit CreateRoom does not
 * update max_participants of an existing room, so later admin changes apply to
 * new calls/links only — active ones keep their snapshot (no disconnects).
 * Direct rooms are fixed at 2 regardless of the setting. The clamp is defensive
 * only: the Filament form validates the same range before a value reaches
 * app_settings. Capacity is an admission bound, not a promise that the
 * SFU/network sustains it.
 */
class CallCapacity
{
    public const MIN = 2;

    public const MAX = 50;

    public function __construct(private SettingsService $settings) {}

    /** Capacity for group calls and public meetings. */
    public function group(): int
    {
        return max(self::MIN, min(self::MAX, $this->settings->int('call.max_participants')));
    }

    /** Capacity for a room call; direct rooms never follow the setting. */
    public function forRoom(bool $isDm): int
    {
        return $isDm ? 2 : $this->group();
    }
}
