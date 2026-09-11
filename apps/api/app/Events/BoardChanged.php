<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/** EVT-064 / FR-KAN-005: no ticket content leaves the workspace channel. */
class BoardChanged extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(public readonly string $workspace) {}

    public function eventName(): string
    {
        return 'board.changed';
    }

    public function channels(): array
    {
        return [new Channel("workspace.{$this->workspace}")];
    }

    protected function workspaceId(): ?string
    {
        return $this->workspace;
    }
}
