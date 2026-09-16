<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-082 `public_chat.room.created` — private-workspace.{wid} ONLY.
 *
 * Queue liveness: a partner creating a room must make the agents' list and the
 * rail badge move without a poll. There is deliberately no visitor-channel
 * variant — at creation time nobody is subscribed to the room yet, and the
 * visitor learns the room exists by opening their own link.
 */
class PublicChatRoomCreated extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    /**
     * @param  array<string, mixed>  $roomPayload  PublicChatStaffSerializer::room() output
     */
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly array $roomPayload,
    ) {}

    public function eventName(): string
    {
        return 'public_chat.room.created';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("workspace.{$this->room->workspace_id}")];
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
        return ['room' => $this->roomPayload];
    }
}
