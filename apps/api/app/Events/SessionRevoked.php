<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * EVT-022 — pushed to private-user.{id} when a session dies
 * (eviction, remote revoke, password change, admin suspend).
 */
class SessionRevoked extends RealtimeEvent
{
    public function __construct(
        public readonly string $userId,
        public readonly string $sessionId,
        public readonly string $reason, // rotation-evict|remote-logout|password_change|admin|logout
    ) {}

    public function eventName(): string
    {
        return 'session.revoked';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        return [new PrivateChannel('user.'.$this->userId)];
    }

    protected function payload(): array
    {
        return [
            'session_id' => $this->sessionId,
            'reason' => $this->reason,
        ];
    }
}
