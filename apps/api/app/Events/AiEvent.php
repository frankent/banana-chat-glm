<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;

/**
 * EVT-050..056 — AI assistant events on private-user.{uid}. User-scoped,
 * so no workspace_id in the envelope.
 */
class AiEvent extends RealtimeEvent
{
    /**
     * @param  array<string, mixed>  $data
     */
    public function __construct(
        public readonly string $userId,
        public readonly string $name, // ai.message.started / .delta / .completed / .failed / ai.conversation.updated / .deleted / .compacted
        public readonly array $data,
    ) {}

    public function eventName(): string
    {
        return $this->name;
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("user.{$this->userId}")];
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return $this->data;
    }
}
