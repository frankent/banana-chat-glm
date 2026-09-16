<?php

namespace App\Events;

use App\Enums\PublicChatSenderKind;
use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-085 `public_chat.typing` — VISITOR VARIANT.
 *
 * sender_kind ONLY. "Someone from support is typing" is the whole signal a
 * customer gets; a username here would undo the snapshot discipline that keeps
 * `users` off the public surface entirely.
 *
 * Not ShouldDispatchAfterCommit: typing is ephemeral, fires outside any
 * transaction, and a deferred keystroke indicator is worse than none.
 */
class PublicChatTyping extends RealtimeEvent
{
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly PublicChatSenderKind $senderKind,
    ) {}

    public function eventName(): string
    {
        return 'public_chat.typing';
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
        return null;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return [
            'room_id' => $this->room->id,
            'sender_kind' => $this->senderKind->value,
        ];
    }
}
