<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-086 `user.updated` — private-user.{id}. Nudge, not transport: the
 * user's own settings changed (FR-NOTI-009 privacy toggle via API-072) and
 * their OTHER already-open clients must drop their cached copy and re-fetch
 * /me — until they do, a stale privacy_mode=false keeps rendering
 * real-content desktop popups. FR-PROF-006 also fires it when PATCH /me
 * changes avatar_attachment_id or display_name (alongside the EVT-087
 * workspace broadcast), so the user's other tabs refresh their own profile.
 * Deliberately carries no values and no PII; the client re-reads the source
 * of truth.
 */
class UserSettingsUpdated extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(
        public readonly string $userId,
    ) {}

    public function eventName(): string
    {
        return 'user.updated';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        return [new Channel("user.{$this->userId}")];
    }

    protected function payload(): array
    {
        return [];
    }
}
