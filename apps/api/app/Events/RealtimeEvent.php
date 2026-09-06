<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Date;

/**
 * Base for realtime events — spec §9 envelope: {event, workspace_id, data, emitted_at}
 * broadcast on private channels.
 */
abstract class RealtimeEvent implements ShouldBroadcast
{
    use SerializesModels;

    /**
     * Dotted event name, e.g. `session.revoked`, `message.created`.
     */
    abstract public function eventName(): string;

    /**
     * Channel name without prefix, e.g. `user.{id}` → private-user.{id}.
     *
     * @return array<int, Channel>
     */
    abstract public function channels(): array;

    public function broadcastAs(): string
    {
        return $this->eventName();
    }

    public function broadcastOn(): array
    {
        return array_map(
            fn (Channel $channel) => $channel instanceof PrivateChannel ? $channel : new PrivateChannel((string) $channel),
            $this->channels(),
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function broadcastWith(): array
    {
        return [
            'event' => $this->eventName(),
            'workspace_id' => $this->workspaceId(),
            'data' => $this->payload(),
            'emitted_at' => Date::now()->toIso8601String(),
        ];
    }

    protected function workspaceId(): ?string
    {
        return null; // user-scoped events carry none
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return [];
    }
}
