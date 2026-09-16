<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-080 `public_chat.message.created` — STAFF CHANNEL VARIANT (DEC-065).
 *
 * private-public-chat-staff.{roomId} is authorised in routes/channels.php for
 * active workspace members only and is NOT derivable from any visitor input:
 * API-215 can only ever sign 'private-public-chat.'.{the caller's own room id}.
 */
class PublicChatMessageCreatedStaff extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    /**
     * @param  array<string, mixed>  $message  PublicChatStaffSerializer::message() output
     */
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly array $message,
    ) {}

    public function eventName(): string
    {
        return 'public_chat.message.created';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("public-chat-staff.{$this->room->id}")];
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
        return ['room_id' => $this->room->id, 'message' => $this->message];
    }
}
