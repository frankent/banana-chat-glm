<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\AvatarUrls;
use App\Domain\Room\RoomPolicy;
use App\Domain\Workspace\WorkspaceSummaryBuilder;
use App\Enums\UserStatus;
use App\Enums\WorkspaceRole;
use App\Events\WorkspaceUpdated;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * API-011/012/050 — workspace-scoped reads (FR-WS-001..005).
 */
class WorkspaceController extends Controller
{
    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly SettingsService $settings,
        private readonly AuditLogger $audit,
        private readonly RoomPolicy $roomPolicy,
    ) {}

    /**
     * API-011 — member directory: search display_name/username, hide deactivated,
     * cursor pagination (default 50).
     */
    /** API-138: preserve cursor metadata inside the typed data envelope. */
    public function directory(Request $request): JsonResponse
    {
        $page = $this->members($request)->getData(true);

        return response()->json(['data' => ['members' => $page['data'], 'next_cursor' => $page['meta']['next_cursor']]]);
    }

    public function members(Request $request): JsonResponse
    {
        $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:50'],
            'room_id' => ['nullable', 'ulid'],
        ]);

        // FR-ROOM-004 / DEC-096 — with room_id the caller (an active member of that
        // room) gets an `in_room` flag per row, so the add-members picker can grey
        // out people already inside without paging the whole roster.
        $roomId = $request->query('room_id');
        if ($roomId !== null && $roomId !== '') {
            $room = Room::query()->whereNull('deleted_at')->findOrFail($roomId);
            if ($this->roomPolicy->membership($room, $request->user()) === null) {
                throw ApiException::roomNotMember();
            }
        } else {
            $roomId = null;
        }

        $q = trim((string) $request->query('q', ''));
        $limit = (int) $request->query('limit', 50);

        $query = WorkspaceMember::query()
            ->where('workspace_members.workspace_id', $this->context->id())
            ->where('workspace_members.status', 'active')
            ->where('users.status', '!=', UserStatus::Deactivated->value)
            ->join('users', 'users.id', '=', 'workspace_members.user_id')
            ->orderBy('users.display_name')->orderBy('users.id')
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

        $inRoom = $roomId === null ? collect() : RoomMember::query()
            ->where('room_id', $roomId)
            ->whereNull('left_at')
            ->whereIn('user_id', collect($members->items())->pluck('id'))
            ->pluck('user_id')
            ->flip();

        $offlineAfter = $this->settings->int('presence.offline_after_seconds');

        // FR-PROF-006 — one batched avatar query for the whole page (join
        // rows, no relation to eager-load).
        $avatars = AvatarUrls::mapFor(collect($members->items())->pluck('avatar_attachment_id'));

        return response()->json([
            'data' => collect($members->items())->map(function ($m) use ($offlineAfter, $avatars, $roomId, $inRoom) {
                $lastSeen = $m->last_seen_at !== null
                    ? Carbon::parse($m->last_seen_at)
                    : null;

                return [
                    ...($roomId !== null ? ['in_room' => $inRoom->has($m->id)] : []),
                    'id' => $m->id,
                    'username' => $m->username,
                    'display_name' => $m->display_name,
                    'avatar_attachment_id' => $m->avatar_attachment_id,
                    'avatar' => $avatars->get($m->avatar_attachment_id),
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
                'workspace' => WorkspaceSummaryBuilder::identity($workspace, $this->avatar($workspace)),
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
     * API-013 / FR-WS-004 / DEC-093 — owner/admin (or system admin) changes the
     * workspace name and photo. The slug is the routing header and never
     * changes here. A non-null avatar id must be the actor's OWN ready
     * kind=avatar upload (same rule as PATCH /me and PATCH /rooms).
     */
    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:100'],
            'avatar_attachment_id' => ['sometimes', 'nullable', 'ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();
        $rank = $this->context->membership()?->role?->rank() ?? 0;

        if (! $user->is_system_admin && $rank < WorkspaceRole::Admin->rank()) {
            throw ApiException::workspaceForbidden();
        }

        $workspace = $this->context->workspace();

        $avatarChanges = array_key_exists('avatar_attachment_id', $data)
            && $data['avatar_attachment_id'] !== $workspace->avatar_attachment_id;

        if ($avatarChanges && $data['avatar_attachment_id'] !== null) {
            AvatarUrls::assertOwnReadyUpload($data['avatar_attachment_id'], $user);
        }

        $renamed = isset($data['name']) && trim($data['name']) !== $workspace->name;

        if ($renamed || $avatarChanges) {
            DB::transaction(function () use ($workspace, $data, $renamed, $avatarChanges): void {
                if ($renamed) {
                    $workspace->name = trim($data['name']);
                }
                if ($avatarChanges) {
                    $workspace->avatar_attachment_id = $data['avatar_attachment_id'];
                }
                $workspace->save();
            });

            broadcast(new WorkspaceUpdated($workspace->id));
            $this->audit->log('workspace.updated', actor: $user, targetType: 'workspace', targetId: $workspace->id, context: [
                'fields' => array_values(array_filter([$renamed ? 'name' : null, $avatarChanges ? 'avatar_attachment_id' : null])),
            ], workspaceId: $workspace->id);
        }

        return response()->json(['data' => ['workspace' => WorkspaceSummaryBuilder::identity($workspace, $this->avatar($workspace))]]);
    }

    /** @return array{sm: string, md: string, animated: string|null}|null */
    private function avatar(Workspace $workspace): ?array
    {
        return $workspace->avatar_attachment_id === null
            ? null
            : AvatarUrls::mapFor([$workspace->avatar_attachment_id])->get($workspace->avatar_attachment_id);
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
