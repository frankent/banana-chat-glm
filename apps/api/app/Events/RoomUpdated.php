<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-002 `room.updated` — private-room.{rid}.
 */
class RoomUpdated extends RealtimeEvent
{
    public function __construct(public readonly Room $room)
    {
        //
    }

    public function eventName(): string
    {
        return 'room.updated';
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
            'room' => [
                'id' => $this->room->id,
                'name' => $this->room->name,
                'description' => $this->room->description,
                'avatar_attachment_id' => $this->room->avatar_attachment_id,
                'settings' => $this->room->settings,
                'member_count' => $this->room->member_count,
            ],
        ];
    }
}
