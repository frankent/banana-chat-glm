<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-081 `public_chat.room.changed` — VISITOR VARIANT.
 *
 * {status_public, can_send} AND NOTHING ELSE. The visitor never learns who is
 * assigned, that anyone is assigned, or that support flagged the conversation
 * `problem` — status is projected through PublicChatStatus::public()
 * (MANDATORY graft 1). This is what lets an agent reopening a `done` room
 * re-enable the customer's composer immediately without telling them anything
 * about our queue.
 */
class PublicChatRoomChanged extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly bool $canSend,
    ) {}

    public function eventName(): string
    {
        return 'public_chat.room.changed';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("public-chat.{$this->room->id}")];
    }

    protected function workspaceId(): ?string
    {
        return null; // payload minimality — see PublicChatMessageCreated
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return [
            'room' => [
                'id' => $this->room->id,
                'status_public' => $this->room->statusPublic(),
                'can_send' => $this->canSend,
            ],
        ];
    }
}
