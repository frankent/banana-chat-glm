<?php

namespace App\Events;

use App\Models\WorkspaceMember;
use Illuminate\Broadcasting\Channel;

/** EVT-020/021 — refresh workspace membership on the member's private feed. */
class WorkspaceMembershipChanged extends RealtimeEvent
{
    public function __construct(public readonly WorkspaceMember $membership, private readonly string $name) {}

    public function eventName(): string
    {
        return $this->name;
    }

    public function channels(): array
    {
        return [new Channel('user.'.$this->membership->user_id)];
    }

    protected function workspaceId(): ?string
    {
        return $this->membership->workspace_id;
    }

    protected function payload(): array
    {
        return ['workspace_id' => $this->membership->workspace_id, 'workspace' => $this->membership->workspace?->only(['id', 'slug', 'name', 'status']), 'role' => $this->membership->role->value];
    }
}
