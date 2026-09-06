<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;

/**
 * EVT-024 `workspace.unread_changed` — private-user.{uid} (FR-READ-003).
 * Emitted immediately (500ms debounce deferred — deviation log #4).
 */
class WorkspaceUnreadChanged extends RealtimeEvent
{
    public function __construct(
        public readonly string $workspaceId,
        public readonly string $userId,
        public readonly int $unreadRoomsCount,
        public readonly int $totalUnread,
    ) {
        //
    }

    public function eventName(): string
    {
        return 'workspace.unread_changed';
    }

    /**
     * @return array<int, Channel>
     */
    public function channels(): array
    {
        return [new Channel("user.{$this->userId}")];
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
        return [
            'workspace_id' => $this->workspaceId,
            'unread_rooms_count' => $this->unreadRoomsCount,
            'total_unread' => $this->totalUnread,
        ];
    }
}
