<?php

namespace App\Domain\Workspace;

use App\Models\RoomMember;
use App\Models\User;
use Illuminate\Support\Collection;

/**
 * §8.8 WorkspaceSummary — canonical nested shape shared by the login
 * response (API-001) and GET /me/workspaces (API-008).
 */
class WorkspaceSummaryBuilder
{
    /**
     * @return Collection<int, array<string, mixed>>
     */
    public function forUser(User $user): Collection
    {
        $memberships = $user->workspaceMemberships()
            ->with('workspace')
            ->where('status', 'active')
            ->get();

        return $memberships->map(function ($membership) {
            $unread = RoomMember::query()
                ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
                ->where('room_members.user_id', $membership->user_id)
                ->where('room_members.workspace_id', $membership->workspace_id)
                ->whereNull('room_members.left_at')
                ->whereColumn('room_members.last_read_seq', '<', 'rooms.last_user_seq')
                ->count();

            return [
                'workspace' => [
                    'id' => $membership->workspace->id,
                    'slug' => $membership->workspace->slug,
                    'name' => $membership->workspace->name,
                    'status' => $membership->workspace->status->value,
                ],
                'role' => $membership->role->value,
                'unread_rooms_count' => $unread,
                'total_unread' => 0, // PH1: badge total derived client-side from room list
            ];
        })->values();
    }
}
