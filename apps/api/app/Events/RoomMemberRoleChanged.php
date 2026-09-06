<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-006 `room.member_role_changed` — private-room.{rid}.
 */
class RoomMemberRoleChanged extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly string $userId,
        public readonly string $role,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'room.member_role_changed';
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
            'role' => $this->role,
        ];
    }
}
