<?php

namespace App\Events;

use App\Models\Room;
use App\Models\User;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-004 `room.member_added` — private-room.{rid}.
 */
class RoomMemberAdded extends RealtimeEvent
{
    /**
     * @param  array<int, User>  $added
     */
    public function __construct(
        public readonly Room $room,
        public readonly array $added,
        public readonly string $actorId,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'room.member_added';
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
            'members' => array_map(fn (User $user) => [
                'user_id' => $user->id,
                'username' => $user->username,
                'display_name' => $user->display_name,
            ], $this->added),
            'actor_id' => $this->actorId,
        ];
    }
}
