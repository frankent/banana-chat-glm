<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-005 `room.member_removed` — private-room.{rid} + private-user.{removed}.
 */
class RoomMemberRemoved extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly string $userId,
        public readonly string $actorId,
        public readonly string $reason, // removed|left
    ) {
        //
    }

    public function eventName(): string
    {
        return 'room.member_removed';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [
            new Channel("room.{$this->room->id}"),
            new Channel("user.{$this->userId}"),
        ];
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
            'actor_id' => $this->actorId,
            'reason' => $this->reason,
        ];
    }
}
