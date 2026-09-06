<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-001 `room.created` — private-user.{uid} for every member.
 */
class RoomCreated extends RealtimeEvent
{
    public function __construct(public readonly Room $room)
    {
        //
    }

    public function eventName(): string
    {
        return 'room.created';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return $this->room->members()
            ->pluck('users.id')
            ->map(fn (string $id) => new Channel("user.{$id}"))
            ->all();
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
                'workspace_id' => $this->room->workspace_id,
                'type' => $this->room->type->value,
                'name' => $this->room->name,
                'description' => $this->room->description,
                'avatar_attachment_id' => $this->room->avatar_attachment_id,
                'created_by' => $this->room->created_by,
                'member_count' => $this->room->member_count,
                'last_message_at' => $this->room->last_message_at?->toIso8601String(),
                'last_seq' => $this->room->last_seq,
            ],
        ];
    }
}
