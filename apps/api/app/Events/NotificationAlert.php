<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/** FR-NOTI-007 — eligible audible event, with no message content. */
class NotificationAlert extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(
        public readonly string $userId,
        public readonly string $id,
        public readonly ?string $roomId,
        public readonly ?string $workspace,
        public readonly string $kind,
        /**
         * Whether this recipient wants the chime. It rides along rather than gating
         * the broadcast, because the same event also drives the OS popup: gating it
         * server-side meant switching off "notification sound" silently switched off
         * every desktop notification too.
         */
        public readonly bool $sound = true,
    ) {}

    public function eventName(): string
    {
        return 'notification.alert';
    }

    public function channels(): array
    {
        return [new Channel("user.{$this->userId}")];
    }

    protected function workspaceId(): ?string
    {
        return $this->workspace;
    }

    protected function payload(): array
    {
        return ['id' => $this->id, 'room_id' => $this->roomId, 'kind' => $this->kind, 'sound' => $this->sound];
    }
}
