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
            ->whereHas('workspace', fn ($query) => $query->where('status', 'active'))
            ->get();

        return $memberships->map(function ($membership) {
            $unread = RoomMember::query()
                ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
                ->where('room_members.user_id', $membership->user_id)
                ->where('room_members.workspace_id', $membership->workspace_id)
                ->whereNull('room_members.left_at')
                ->whereNull('rooms.deleted_at')
                ->whereColumn('room_members.last_read_seq', '<', 'rooms.last_user_seq')
                ->whereNotExists(function ($query) use ($membership) {
                    $query->selectRaw('1')->from('room_notification_settings')
                        ->whereColumn('room_notification_settings.room_id', 'rooms.id')
                        ->where('room_notification_settings.user_id', $membership->user_id)
                        ->where(fn ($q) => $q->where('mode', 'none')->orWhere('muted_until', '>', now()));
                })
                ->selectRaw('count(*) as rooms, coalesce(sum(rooms.last_user_seq - room_members.last_read_seq), 0) as total')
                ->first();

            // FR-MSG-008 — any mention in this ws I haven't read past yet (PH2)
            $hasMentions = RoomMember::query()
                ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
                ->join('messages', 'messages.room_id', '=', 'rooms.id')
                ->join('message_mentions', 'message_mentions.message_id', '=', 'messages.id')
                ->where('room_members.user_id', $membership->user_id)
                ->where('room_members.workspace_id', $membership->workspace_id)
                ->whereNull('room_members.left_at')
                ->where('message_mentions.user_id', $membership->user_id)
                ->whereNull('messages.deleted_at')
                ->whereColumn('messages.seq', '>', 'room_members.last_read_seq')
                ->exists();

            return [
                'workspace' => [
                    'id' => $membership->workspace->id,
                    'slug' => $membership->workspace->slug,
                    'name' => $membership->workspace->name,
                    'status' => $membership->workspace->status->value,
                ],
                'role' => $membership->role->value,
                'unread_rooms_count' => (int) $unread->rooms,
                'total_unread' => (int) $unread->total,
                'has_mentions' => $hasMentions,
            ];
        })->values();
    }
}
