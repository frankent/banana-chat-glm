<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-003 `room.deleted` — private-room.{rid} + private-user.{uid} for every member.
 *
 * Carries scalar ids only (FR-ROOM-012): the event is queued, and
 * SerializesModels would rehydrate the Room by primary key on the worker —
 * impossible after the secret-room purge hard-deletes the row. Builders
 * snapshot via forRoom() before the room disappears.
 */
class RoomDeleted extends RealtimeEvent
{
    /**
     * @param  array<int, string>  $memberIds  captured before the room vanished from lists
     */
    public function __construct(
        public readonly string $roomId,
        public readonly string $workspaceId,
        public readonly array $memberIds,
    ) {}

    /** Snapshot the ids while the row still exists. */
    public static function forRoom(Room $room, array $memberIds): self
    {
        return new self($room->id, $room->workspace_id, $memberIds);
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
        $channels = [new Channel("room.{$this->roomId}")];

        foreach ($this->memberIds as $id) {
            $channels[] = new Channel("user.{$id}");
        }

        return $channels;
    }

    protected function workspaceId(): ?string
    {
        return $this->workspaceId;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return ['room_id' => $this->roomId];
    }
}
