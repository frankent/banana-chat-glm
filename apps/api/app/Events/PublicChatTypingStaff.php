<?php

namespace App\Events;

use App\Enums\PublicChatSenderKind;
use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-085 `public_chat.typing` — STAFF VARIANT. Agents may see which colleague
 * is typing, and that a visitor is.
 */
class PublicChatTypingStaff extends RealtimeEvent
{
    /**
     * @param  array<string, mixed>|null  $user  {id, username, display_name}; null for a visitor
     */
    public function __construct(
        public readonly PublicChatRoom $room,
        public readonly PublicChatSenderKind $senderKind,
        public readonly ?array $user = null,
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
        return [
            'room_id' => $this->room->id,
            'sender_kind' => $this->senderKind->value,
            'user' => $this->user,
        ];
    }
}
