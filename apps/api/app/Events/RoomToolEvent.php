<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/** EVT-060..062 — room tools and ephemeral, server-attributed typing. */
class RoomToolEvent extends RealtimeEvent implements ShouldBroadcastNow
{
    public function __construct(public readonly Room $room, private readonly string $name, private readonly array $data = []) {}

    public function eventName(): string
    {
        return $this->name;
    }

    public function channels(): array
    {
        return [new Channel('room.'.$this->room->id)];
    }

    protected function workspaceId(): ?string
    {
        return $this->room->workspace_id;
    }

    protected function payload(): array
    {
        return ['room_id' => $this->room->id, ...$this->data];
    }
}
