<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-015 `room.activity` — private-user.{uid}; keeps room lists and badges
 * correct for rooms the user has not subscribed (DEC-009).
 */
class RoomActivity extends RealtimeEvent
{
    public function __construct(
        public readonly Room $room,
        public readonly string $userId,
        public readonly ?string $lastMessagePreview,
        public readonly int $unreadCount,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'room.activity';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("user.{$this->userId}")];
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
            'last_seq' => (int) $this->room->last_seq,
            'last_message_preview' => $this->lastMessagePreview,
            'unread_count' => $this->unreadCount,
        ];
    }
}
