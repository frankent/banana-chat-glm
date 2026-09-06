<?php

namespace App\Events;

use App\Models\Room;
use Illuminate\Broadcasting\Channel;

/**
 * EVT-010 `message.created` — private-room.{rid} (FR-MSG-001).
 */
class MessageCreated extends RealtimeEvent
{
    /**
     * @param  array<string, mixed>  $message  pre-serialized §8.8 message
     */
    public function __construct(
        public readonly Room $room,
        public readonly array $message,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'message.created';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("room.{$this->room->id}")];
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
        return ['message' => $this->message];
    }
}
