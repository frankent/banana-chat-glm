<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-081 `public_chat.room.changed` — STAFF VARIANT.
 *
 * Two channels: the room's own staff channel (an agent with the conversation
 * open) AND private-workspace.{wid} (every agent's queue list and rail badge,
 * FR-PCHAT-003/004). The workspace channel already exists and already proves
 * active membership in routes/channels.php, so list liveness costs no new
 * authorisation surface.
 */
class PublicChatRoomChangedStaff extends RealtimeEvent implements ShouldDispatchAfterCommit
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
        return 'public_chat.room.changed';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [
            new Channel("public-chat-staff.{$this->room->id}"),
            new Channel("workspace.{$this->room->workspace_id}"),
        ];
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
