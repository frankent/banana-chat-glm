<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-013 `room.read` — private-room.{rid} (FR-READ-001).
 */
class RoomRead extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly string $userId,
        public readonly int $lastReadSeq,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'room.read';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("room.{$this->room->id}")];
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
            'room_id' => $this->room->id,
            'user_id' => $this->userId,
            'last_read_seq' => $this->lastReadSeq,
        ];
    }
}
