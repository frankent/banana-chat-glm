<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

class CallChanged extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(public readonly string $workspace, public readonly array $users) {}

    public function eventName(): string
    {
        return 'call.changed';
    }

    public function channels(): array
    {
        return array_map(fn ($id) => new Channel('user.'.$id), $this->users);
    }

    protected function workspaceId(): ?string
    {
        return $this->workspace;
    }
}
