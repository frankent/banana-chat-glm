<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-003 `room.deleted` — private-room.{rid} + private-user.{uid} for every member.
 */
class RoomDeleted extends RealtimeEvent
{
    /** @param array<int, string> $memberIds captured before the room vanished from lists */
    public function __construct(public readonly Room $room, public readonly array $memberIds)
    {
        //
    }

    public function eventName(): string
    {
        return 'room.deleted';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        $channels = [new Channel("room.{$this->room->id}")];

        foreach ($this->memberIds as $id) {
            $channels[] = new Channel("user.{$id}");
        }

        return $channels;
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
        return ['room_id' => $this->room->id];
    }
}
