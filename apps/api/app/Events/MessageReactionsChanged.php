<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * EVT-089 — message.reactions_changed on private-room.{id} (FR-MSG-012).
 * Carries NO per-viewer data: clients learn "my_reaction" only from their own
 * REST response, or from actor_emoji when actor_id is themselves.
 * No push, no unread change.
 */
class MessageReactionsChanged extends RealtimeEvent implements ShouldBroadcastNow
{
    /**
     * @param  list<array{emoji: string, count: int}>  $reactions
     */
    public function __construct(
        public readonly Room $room,
        public readonly string $messageId,
        public readonly array $reactions,
        public readonly string $actorId,
        public readonly ?string $actorEmoji,
    ) {}

    public function eventName(): string
    {
        return 'message.reactions_changed';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        return [new PrivateChannel('room.'.$this->room->id)];
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
            'message_id' => $this->messageId,
            'reactions' => $this->reactions,
            'actor_id' => $this->actorId,
            'actor_emoji' => $this->actorEmoji,
        ];
    }
}
