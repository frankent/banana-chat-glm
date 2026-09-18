<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * EVT-050..056 — AI assistant events on private-user.{uid}. User-scoped,
 * so no workspace_id in the envelope.
 *
 * Broadcast synchronously, unlike every other realtime event. These are emitted
 * from inside GenerateAiReply, which is already a queued job — putting each delta
 * on the queue again just to get it to Reverb meant a worker with the default
 * three-second sleep decided when the user saw it. Measured over the websocket:
 * deltas arrived in clumps at 10.1s, 13.1s and 16.1s, three seconds apart to the
 * millisecond, which is what made a streaming answer look like one slow lump.
 * Reverb is on the same Docker network, so the synchronous publish costs a few ms
 * on a job that already runs for many seconds.
 */
class AiEvent extends RealtimeEvent implements ShouldBroadcastNow
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
