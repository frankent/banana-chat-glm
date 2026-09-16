<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-083 `public_chat.message.deleted` — BOTH room channels.
 *
 * This is the ONE public-chat event with a single class for two channels, and
 * it is safe only because the payload is a pure tombstone: an id and a seq, no
 * author, no body, no deleter. If you ever need to say WHO deleted a row, split
 * this into two classes the way EVT-080/081 are split — do not add the field
 * here. The staff-side deleter identity is available from API-222.
 *
 * API-226 exists at all because MessageEditor::assertDeletableBy falls through
 * to a moderator branch requiring RoomRole::Owner|Admin for a NULL-sender row,
 * which in a shared-table design would have made visitor messages — the content
 * most likely to need removal, e.g. a pasted card number — undeletable by
 * anyone.
 */
class PublicChatMessageDeleted extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly string $messageId,
        public readonly int $seq,
    ) {}

    public function eventName(): string
    {
        return 'public_chat.message.deleted';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [
            new Channel("public-chat.{$this->room->id}"),
            new Channel("public-chat-staff.{$this->room->id}"),
        ];
    }

    /**
     * Withheld: this envelope reaches the visitor channel, and a single class
     * cannot carry a field only one of its two audiences may see.
     */
    protected function workspaceId(): ?string
    {
        return null;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return [
            'room_id' => $this->room->id,
            'message_id' => $this->messageId,
            'seq' => $this->seq,
        ];
    }
}
