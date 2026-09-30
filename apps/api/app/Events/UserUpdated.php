<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;

/**
 * EVT-087 `user.updated` — private-workspace.{wid} for EVERY workspace the
 * user is an active member of (FR-PROF-006 / API-009). Fired after commit
 * when PATCH /me really changes avatar_attachment_id or display_name — the
 * two fields other members can see. Like EVT-086, a nudge not a transport:
 * data carries {user_id} only, no names, no URLs — members re-fetch whatever
 * list they are looking at. Never referenced by a push/FCM payload.
 */
class UserUpdated extends RealtimeEvent implements ShouldDispatchAfterCommit
{
    /**
     * @param  list<string>  $workspaceIds  active memberships only; empty list = nothing to say
     */
    public function __construct(
        public readonly string $userId,
        public readonly array $workspaceIds,
    ) {}

    public function eventName(): string
    {
        return 'user.updated';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return array_map(
            fn (string $workspaceId) => new Channel("workspace.{$workspaceId}"),
            $this->workspaceIds,
        );
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return ['user_id' => $this->userId];
    }
}
