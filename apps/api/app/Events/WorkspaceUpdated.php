<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-088 `workspace.updated` — private-workspace.{wid} (FR-WS-004 / API-013).
 * Fired after commit when PATCH /workspace really changes the name or the
 * photo. A nudge, not a transport: {workspace_id} only — no name, no signed
 * URL (DEC-088) — members re-fetch /me/workspaces.
 */
class WorkspaceUpdated extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    public function __construct(public readonly string $workspaceId) {}

    public function eventName(): string
    {
        return 'workspace.updated';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("workspace.{$this->workspaceId}")];
    }

    protected function workspaceId(): ?string
    {
        return $this->workspaceId;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return ['workspace_id' => $this->workspaceId];
    }
}
