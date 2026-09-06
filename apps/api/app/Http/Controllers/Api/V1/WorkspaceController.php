<?php

namespace App\Http\Controllers\Api\V1;

use App\Enums\UserStatus;
use App\Http\Controllers\Controller;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\WorkspaceMember;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * API-011/012/050 — workspace-scoped reads (FR-WS-001..005).
 */
class WorkspaceController extends Controller
{
    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly SettingsService $settings,
    ) {}

    /**
     * API-011 — member directory: search display_name/username, hide deactivated,
     * cursor pagination (default 50).
     */
    public function members(Request $request): JsonResponse
    {
        $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);

        $q = trim((string) $request->query('q', ''));
        $limit = (int) $request->query('limit', 50);

        $query = WorkspaceMember::query()
            ->where('workspace_members.workspace_id', $this->context->id())
            ->where('workspace_members.status', 'active')
            ->where('users.status', '!=', UserStatus::Deactivated->value)
            ->join('users', 'users.id', '=', 'workspace_members.user_id')
            ->orderBy('users.display_name')
            ->select([
                'users.id', 'users.username', 'users.display_name',
                'users.avatar_attachment_id', 'users.last_seen_at', 'users.status',
                'workspace_members.role as workspace_role',
            ]);

        if ($q !== '') {
            $query->where(function ($builder) use ($q) {
                $builder->where('users.display_name', 'ilike', "%{$q}%")
                    ->orWhere('users.username', 'ilike', "%{$q}%");
            });
        }

        $members = $query->cursorPaginate($limit);

        $offlineAfter = $this->settings->int('presence.offline_after_seconds');

        return response()->json([
            'data' => collect($members->items())->map(function ($m) use ($offlineAfter) {
                $lastSeen = $m->last_seen_at !== null
                    ? Carbon::parse($m->last_seen_at)
                    : null;

                return [
                    'id' => $m->id,
                    'username' => $m->username,
                    'display_name' => $m->display_name,
                    'avatar_attachment_id' => $m->avatar_attachment_id,
                    'role' => $m->workspace_role,
                    'presence' => $lastSeen !== null && $lastSeen->diffInSeconds(now()) < $offlineAfter ? 'online' : 'offline',
                    'last_seen_at' => $lastSeen?->toIso8601String(),
                ];
            })->values(),
            'meta' => [
                'next_cursor' => $members->nextCursor()?->encode(),
                'has_more' => $members->hasMorePages(),
            ],
        ]);
    }

    /**
     * API-012 — current workspace info.
     */
    public function show(): JsonResponse
    {
        $workspace = $this->context->workspace();
        $membership = $this->context->membership();

        return response()->json([
            'data' => [
                'workspace' => [
                    'id' => $workspace->id,
                    'slug' => $workspace->slug,
                    'name' => $workspace->name,
                    'status' => $workspace->status->value,
                ],
                'my_role' => $membership->role->value,
                'stats' => [
                    'member_count' => WorkspaceMember::query()
                        ->where('workspace_id', $workspace->id)
                        ->where('status', 'active')
                        ->count(),
                    'room_count' => Room::query()->whereNull('deleted_at')->count(),
                ],
            ],
        ]);
    }

    /**
     * API-050 — minimal sync: rooms changed since a timestamp.
     * Full members_changed arrives with presence (PH2).
     */
    public function sync(Request $request): JsonResponse
    {
        $request->validate([
            'since' => ['nullable', 'date'],
        ]);

        $since = $request->date('since') ?? now()->subDays(7);
        $workspace = $this->context->workspace();
        $userId = $request->user()->id;

        $memberships = RoomMember::query()
            ->where('room_members.workspace_id', $workspace->id)
            ->where('room_members.user_id', $userId)
            ->whereNull('left_at')
            ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
            ->whereNull('rooms.deleted_at')
            ->where(function ($q) use ($since) {
                $q->where('rooms.updated_at', '>', $since)
                    ->orWhereColumn('room_members.last_user_seq', '>', 'room_members.last_read_seq');
            })
            ->orderByDesc('rooms.last_message_at')
            ->select('rooms.*', 'room_members.last_read_seq as pivot_last_read_seq')
            ->limit(200)
            ->get();

        return response()->json([
            'data' => [
                'rooms_changed' => $memberships->map(fn ($room) => [
                    'id' => $room->id,
                    'type' => $room->type,
                    'name' => $room->name,
                    'last_seq' => $room->last_seq,
                    'last_message_at' => $room->last_message_at?->toIso8601String(),
                    'unread_count' => max(0, $room->last_user_seq - $room->pivot_last_read_seq),
                ])->values(),
                'rooms_removed' => [],
                'members_changed' => [],
                'server_time' => now()->toIso8601String(),
            ],
        ]);
    }
}
