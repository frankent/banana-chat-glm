<?php

namespace App\Events;

use App\Models\Message;
use App\Models\Room;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * EVT-011 — message.updated on private-room.{id} (FR-MSG-005).
 * No push, no unread change — edits are silent.
 */
class MessageUpdated extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly array $message,
    ) {}

    public function eventName(): string
    {
        return 'message.updated';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        return [new PrivateChannel('room.'.$this->room->id)];
    }

    protected function workspaceId(): ?string
    {
        return $this->room->workspace_id;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return ['message' => $this->message];
    }
}
