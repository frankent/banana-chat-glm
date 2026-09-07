<?php

namespace App\Events;

use App\Models\Message;
use App\Models\Room;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * EVT-012 — message.deleted on private-room.{id} (FR-MSG-006).
 * Stub payload only: clients swap the row for a placeholder, seq preserved.
 */
class MessageDeleted extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly string $messageId,
        public readonly int $seq,
        public readonly string $deleteReason, // sender|moderator
    ) {}

    public function eventName(): string
    {
        return 'message.deleted';
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
        return [
            'message_id' => $this->messageId,
            'room_id' => $this->room->id,
            'seq' => $this->seq,
            'delete_reason' => $this->deleteReason,
        ];
    }
}
