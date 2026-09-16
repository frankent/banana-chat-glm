<?php

namespace App\Events;

use App\Models\PublicChatRoom;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-080 `public_chat.message.created` — VISITOR CHANNEL VARIANT.
 *
 * DEC-065: there are two classes and two serializers for one logical event
 * because the isolation boundary is enforced AT THE WIRE, not only inside a
 * serializer. Internal identity cannot reach a customer through this class,
 * because this class only ever carries a payload built by
 * PublicChatPublicSerializer and only ever broadcasts on the channel a visitor
 * is allowed to subscribe to.
 *
 * THE CHANNEL IS KEYED BY THE ROOM ULID, NEVER BY THE 64-HEX CODE
 * (MANDATORY fix 12). A Pusher-protocol channel name is public by construction:
 * it travels in every WebSocket subscribe frame, in the
 * pusher:subscription_succeeded echo, in browser devtools, and — because
 * RealtimeEvent is ShouldBroadcast rather than ShouldBroadcastNow — through
 * queued jobs and failed_jobs payloads. The visitor's credential must not be in
 * any of those.
 */
class PublicChatMessageCreated extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    /**
     * @param  array<string, mixed>  $message  PublicChatPublicSerializer::message() output
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
        return [new Channel("public-chat.{$this->room->id}")];
    }

    /**
     * FR-PCHAT-014 payload minimality: the envelope's workspace_id is withheld
     * on every visitor-channel event. The customer has no use for our tenant
     * ULID and it is one more internal identifier on an external surface.
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
        return ['room_id' => $this->room->id, 'message' => $this->message];
    }
}
