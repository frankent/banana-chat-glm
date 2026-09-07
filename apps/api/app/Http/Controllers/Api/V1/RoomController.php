<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Room\Actions\CreateRoomAction;
use App\Domain\Room\RoomPolicy;
use App\Domain\Room\SystemMessageWriter;
use App\Enums\MemberStatus;
use App\Enums\MessageType;
use App\Enums\RoomRole;
use App\Enums\RoomType;
use App\Enums\UserStatus;
use App\Events\RoomDeleted;
use App\Events\RoomMemberAdded;
use App\Events\RoomMemberRemoved;
use App\Events\RoomMemberRoleChanged;
use App\Events\RoomUpdated;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\InAppNotification;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * API-020..031 — rooms, membership, roles (FR-ROOM-001..008, 011).
 * Route binding is workspace-scoped via WorkspaceScope + soft-delete exclusion
 * in routes/api.php — cross-workspace or deleted rooms resolve to 404.
 */
class RoomController extends Controller
{
    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly SettingsService $settings,
        private readonly RoomPolicy $policy,
        private readonly SystemMessageWriter $systemMessages,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * API-021 — list my rooms, last_message_at desc (FR-ROOM-003).
     */
    public function index(Request $request): JsonResponse
    {
        $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
            'filter' => ['nullable', 'string', 'in:all,unread,hidden'],
        ]);

        $limit = (int) $request->query('limit', 50);
        $filter = (string) $request->query('filter', 'all');
        $userId = $request->user()->id;

        $query = RoomMember::query()
            ->where('room_members.workspace_id', $this->context->id())
            ->where('room_members.user_id', $userId)
            ->whereNull('room_members.left_at')
            ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
            ->whereNull('rooms.deleted_at')
            ->orderByDesc('rooms.last_message_at')
            ->select([
                'rooms.*',
                'room_members.role as my_role',
                'room_members.last_read_seq as my_last_read_seq',
                'room_members.hidden_at as my_hidden_at',
            ]);

        if ($filter === 'hidden') {
            $query->whereNotNull('room_members.hidden_at');
        } else {
            $query->whereNull('room_members.hidden_at');
            if ($filter === 'unread') {
                $query->whereColumn('room_members.last_read_seq', '<', 'rooms.last_seq');
            }
        }

        $rooms = $query->cursorPaginate($limit);

        return response()->json([
            'data' => $this->summarize($rooms->items(), $userId),
            'meta' => [
                'next_cursor' => $rooms->nextCursor()?->encode(),
                'has_more' => $rooms->hasMorePages(),
            ],
        ]);
    }

    /**
     * API-020 — create DM (200 dedupe / 201) or group (FR-ROOM-001/002).
     */
    public function store(Request $request, CreateRoomAction $action): JsonResponse
    {
        $data = $request->validate([
            'type' => ['required', 'in:dm,group'],
            'user_id' => ['required_if:type,dm', 'nullable', 'ulid'],
            'name' => ['required_if:type,group', 'nullable', 'string', 'min:1', 'max:100'],
            'description' => ['nullable', 'string', 'max:500'],
            'member_ids' => ['nullable', 'array', 'max:499'],
            'member_ids.*' => ['ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();

        if ($data['type'] === 'dm') {
            [$room, $created] = $action->createDm($user, (string) $data['user_id']);
        } else {
            [$room, $created] = $action->createGroup(
                $user,
                (string) $data['name'],
                $data['description'] ?? null,
                $data['member_ids'] ?? [],
            );
        }

        $membership = $this->policy->membership($room, $user);

        return response()->json([
            'data' => $this->summarize([$room], $user->id, $membership)[0],
        ], $created ? 201 : 200);
    }

    /**
     * API-030 — room detail incl. settings + my_role (FR-ROOM-011).
     */
    public function show(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $this->requireMembership($room, $request->user());

        $membership = $this->policy->membershipOrFail($room, $request->user());

        return response()->json([
            'data' => [
                'room' => [
                    'id' => $room->id,
                    'workspace_id' => $room->workspace_id,
                    'type' => $room->type->value,
                    'name' => $room->name,
                    'description' => $room->description,
                    'avatar_attachment_id' => $room->avatar_attachment_id,
                    'created_by' => $room->created_by,
                    'owner_id' => $room->owner_id,
                    'settings' => $room->settings,
                    'member_count' => $room->member_count,
                    'last_seq' => $room->last_seq,
                    'last_message_at' => $room->last_message_at?->toIso8601String(),
                    'created_at' => $room->created_at?->toIso8601String(),
                ],
                'my_role' => $membership->role->value,
                'my_last_read_seq' => $membership->last_read_seq,
            ],
        ]);
    }

    /**
     * API-022 — patch name/description/avatar/settings (FR-ROOM-007).
     */
    public function update(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:100'],
            'description' => ['sometimes', 'nullable', 'string', 'max:500'],
            'avatar_attachment_id' => ['sometimes', 'nullable', 'ulid'],
            'settings' => ['sometimes', 'array'],
            'settings.who_can_add_members' => ['sometimes', 'in:everyone,admins'],
            'settings.who_can_edit_info' => ['sometimes', 'in:everyone,admins'],
        ]);

        if ($room->isDm()) {
            throw ApiException::roomDmImmutable();
        }

        /** @var User $user */
        $user = $request->user();
        $membership = $this->requireMembership($room, $user);

        $touchesSettings = array_key_exists('settings', $data);
        $this->policy->assertCanEditInfo($room, $membership, $touchesSettings);

        $renamed = isset($data['name']) && trim($data['name']) !== $room->name;

        DB::transaction(function () use ($room, $data): void {
            $attributes = collect($data)->only(['name', 'description', 'avatar_attachment_id'])->all();
            if ($attributes !== []) {
                if (isset($attributes['name'])) {
                    $attributes['name'] = trim($attributes['name']);
                }
                $room->fill($attributes);
            }

            if (array_key_exists('settings', $data)) {
                $room->settings = array_merge($room->settings ?? [], $data['settings']);
            }

            $room->save();
        });

        if ($renamed) {
            $this->systemMessages->write($room, $user, 'room_renamed', [
                'name' => $room->name,
            ]);
            $room->refresh();
        }

        broadcast(new RoomUpdated($room->refresh()));
        $this->audit->log('room.updated', actor: $user, targetType: 'room', targetId: $room->id);

        return response()->json(['data' => ['room' => [
            'id' => $room->id,
            'name' => $room->name,
            'description' => $room->description,
            'avatar_attachment_id' => $room->avatar_attachment_id,
            'settings' => $room->settings,
            'member_count' => $room->member_count,
        ]]]);
    }

    /**
     * API-027 — soft delete group room (FR-ROOM-008).
     */
    public function destroy(Request $request, string $roomId): Response
    {
        $room = $this->roomOrFail($roomId);
        /** @var User $user */
        $user = $request->user();
        $membership = $this->policy->membership($room, $user);

        if ($membership === null && ! $this->policy->canManageEverything($user)) {
            throw ApiException::roomNotMember();
        }

        $this->policy->assertCanDelete($room, $membership);

        $memberIds = $room->members()->pluck('users.id')->all();

        $room->forceFill([
            'deleted_at' => now(),
            'purge_after' => now()->addDays($this->settings->int('room.deleted_purge_days')),
        ])->save();

        broadcast(new RoomDeleted($room, $memberIds));
        $this->audit->log('room.deleted', actor: $user, targetType: 'room', targetId: $room->id);

        return response()->noContent();
    }

    /**
     * API-023 — add members (FR-ROOM-004).
     */
    public function addMembers(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $data = $request->validate([
            'user_ids' => ['required', 'array', 'min:1', 'max:100'],
            'user_ids.*' => ['ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();
        $membership = $this->requireMembership($room, $user);
        $this->policy->assertCanAddMembers($room, $membership);

        $userIds = array_values(array_unique($data['user_ids']));

        $validIds = WorkspaceMember::query()
            ->where('workspace_members.workspace_id', $this->context->id())
            ->where('workspace_members.status', MemberStatus::Active)
            ->whereIn('workspace_members.user_id', $userIds)
            ->join('users', 'users.id', '=', 'workspace_members.user_id')
            ->where('users.status', '!=', UserStatus::Deactivated)
            ->pluck('workspace_members.user_id')
            ->all();

        [$added, $already] = [0, 0];
        $addedUsers = [];

        DB::transaction(function () use ($room, $user, $userIds, $validIds, &$added, &$already, &$addedUsers): void {
            $maxMembers = $this->settings->int('room.group.max_members');

            foreach ($userIds as $userId) {
                if (! in_array($userId, $validIds, true)) {
                    abort(404);
                }

                $existing = RoomMember::query()
                    ->where('room_id', $room->id)
                    ->where('user_id', $userId)
                    ->first();

                if ($existing !== null && $existing->left_at === null) {
                    $already++; // idempotent — no duplicate row, no system message

                    continue;
                }

                if ($room->member_count + 1 > $maxMembers) {
                    throw ApiException::roomFull($maxMembers);
                }

                if ($existing !== null) {
                    // rejoin: no unread backlog from before (DEC-007 allows history scroll)
                    $existing->forceFill([
                        'left_at' => null,
                        'role' => RoomRole::Member,
                        'last_read_seq' => $room->last_seq,
                        'added_by' => $user->id,
                        'joined_at' => now(),
                    ])->save();
                } else {
                    RoomMember::query()->create([
                        'room_id' => $room->id,
                        'user_id' => $userId,
                        'workspace_id' => $room->workspace_id,
                        'role' => RoomRole::Member,
                        'added_by' => $user->id,
                        'last_read_seq' => $room->last_seq,
                    ]);
                }

                $room->forceFill(['member_count' => $room->member_count + 1])->save();
                $added++;
                $addedUsers[] = User::query()->findOrFail($userId);
            }
        });

        if ($added > 0) {
            $this->systemMessages->write($room, $user, 'member_added', [
                'user_ids' => array_map(fn (User $u) => $u->id, $addedUsers),
            ]);
            broadcast(new RoomMemberAdded($room->refresh(), $addedUsers, $user->id));

            // FR-NOTI-006 — "added to room" rows for each newly added user
            foreach ($addedUsers as $addedUser) {
                if ($addedUser->id === $user->id) {
                    continue; // self-add (join) is not a notification
                }
                InAppNotification::query()->create([
                    'user_id' => $addedUser->id,
                    'workspace_id' => $room->workspace_id,
                    'type' => 'added_to_room',
                    'room_id' => $room->id,
                    'actor_id' => $user->id,
                    'data' => ['room_name' => $room->name],
                ]);
            }

            $this->audit->log('room.member_added', actor: $user, targetType: 'room', targetId: $room->id, context: [
                'added' => $added,
            ]);
        }

        return response()->json(['data' => ['added' => $added, 'already' => $already]]);
    }

    /**
     * API-031 — room member list (FR-ROOM-011).
     */
    public function members(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $this->requireMembership($room, $request->user());

        $request->validate(['limit' => ['nullable', 'integer', 'min:1', 'max:100']]);

        $limit = (int) $request->query('limit', 50);

        $members = RoomMember::query()
            ->where('room_id', $room->id)
            ->whereNull('left_at')
            ->join('users', 'users.id', '=', 'room_members.user_id')
            ->orderBy('users.display_name')
            ->cursorPaginate($limit, [
                'users.id', 'users.username', 'users.display_name',
                'users.avatar_attachment_id', 'users.last_seen_at',
                'room_members.role', 'room_members.joined_at',
            ]);

        $offlineAfter = $this->settings->int('presence.offline_after_seconds');

        return response()->json([
            'data' => collect($members->items())->map(function ($m) use ($offlineAfter) {
                $lastSeen = $m->last_seen_at !== null ? Carbon::parse($m->last_seen_at) : null;

                return [
                    'id' => $m->id,
                    'username' => $m->username,
                    'display_name' => $m->display_name,
                    'avatar_attachment_id' => $m->avatar_attachment_id,
                    'role' => $m->role instanceof RoomRole ? $m->role->value : (string) $m->role,
                    'joined_at' => $m->joined_at !== null ? Carbon::parse($m->joined_at)->toIso8601String() : null,
                    'presence' => $lastSeen !== null && $lastSeen->diffInSeconds(now()) < $offlineAfter ? 'online' : 'offline',
                ];
            })->values(),
            'meta' => [
                'next_cursor' => $members->nextCursor()?->encode(),
                'has_more' => $members->hasMorePages(),
            ],
        ]);
    }

    /**
     * API-024 — remove a member (FR-ROOM-004).
     */
    public function removeMember(Request $request, string $roomId, string $userId): Response
    {
        $room = $this->roomOrFail($roomId);
        /** @var User $user */
        $user = $request->user();
        $membership = $this->requireMembership($room, $user);

        $target = RoomMember::query()
            ->where('room_id', $room->id)
            ->where('user_id', $userId)
            ->whereNull('left_at')
            ->firstOrFail();

        $this->policy->assertCanRemoveMember($room, $membership, $target);

        DB::transaction(function () use ($room, $target): void {
            $target->forceFill(['left_at' => now()])->save();
            $room->forceFill(['member_count' => max(0, $room->member_count - 1)])->save();
        });

        $this->systemMessages->write($room, $user, 'member_removed', ['user_id' => $userId]);
        broadcast(new RoomMemberRemoved($room->refresh(), $userId, $user->id, 'removed'));
        $this->audit->log('room.member_removed', actor: $user, targetType: 'room', targetId: $room->id, context: ['user_id' => $userId]);

        return response()->noContent();
    }

    /**
     * API-025 — leave group (FR-ROOM-005).
     */
    public function leave(Request $request, string $roomId): Response
    {
        $room = $this->roomOrFail($roomId);
        if ($room->isDm()) {
            throw ApiException::roomDmImmutable(); // §6.3 — hide instead of leave
        }

        /** @var User $user */
        $user = $request->user();
        $membership = $this->requireMembership($room, $user);

        if ($membership->role === RoomRole::Owner && $room->member_count > 1) {
            throw ApiException::roomOwnerCannotLeave();
        }

        if ($membership->role === RoomRole::Owner) {
            // last member leaving → auto soft delete (FR-ROOM-005)
            $room->forceFill([
                'deleted_at' => now(),
                'purge_after' => now()->addDays($this->settings->int('room.deleted_purge_days')),
            ])->save();
            broadcast(new RoomDeleted($room, [$user->id]));
            $this->audit->log('room.deleted', actor: $user, targetType: 'room', targetId: $room->id, context: ['reason' => 'last_member_left']);

            return response()->noContent();
        }

        DB::transaction(function () use ($room, $membership): void {
            $membership->forceFill(['left_at' => now()])->save();
            $room->forceFill(['member_count' => max(0, $room->member_count - 1)])->save();
        });

        $this->systemMessages->write($room, $user, 'member_left', ['user_id' => $user->id]);
        broadcast(new RoomMemberRemoved($room->refresh(), $user->id, $user->id, 'left'));
        $this->audit->log('room.member_left', actor: $user, targetType: 'room', targetId: $room->id);

        return response()->noContent();
    }

    /**
     * API-026 — change a member's role (FR-ROOM-006).
     */
    public function updateMemberRole(Request $request, string $roomId, string $userId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $data = $request->validate([
            'role' => ['required', 'in:owner,admin,member'],
        ]);

        /** @var User $user */
        $user = $request->user();
        $membership = $this->requireMembership($room, $user);

        $target = RoomMember::query()
            ->where('room_id', $room->id)
            ->where('user_id', $userId)
            ->whereNull('left_at')
            ->firstOrFail();

        $newRole = RoomRole::from($data['role']);
        $this->policy->assertCanChangeRole($room, $membership, $target, $newRole);

        $ownerTransfer = $newRole === RoomRole::Owner
            && $membership->role === RoomRole::Owner
            && $membership->user_id !== $target->user_id;

        DB::transaction(function () use ($room, $membership, $target, $newRole, $ownerTransfer): void {
            // owner transfer: the old owner steps down to admin
            if ($ownerTransfer) {
                $membership->forceFill(['role' => RoomRole::Admin])->save();
                $room->forceFill(['owner_id' => $target->user_id])->save();
            }

            $target->forceFill(['role' => $newRole])->save();
        });

        broadcast(new RoomMemberRoleChanged($room->refresh(), $userId, $newRole->value));
        if ($ownerTransfer) {
            broadcast(new RoomMemberRoleChanged($room->refresh(), $membership->user_id, RoomRole::Admin->value));
        }

        $this->audit->log('room.member_role_changed', actor: $user, targetType: 'room', targetId: $room->id, context: [
            'user_id' => $userId,
            'role' => $newRole->value,
        ]);

        return response()->json(['data' => ['user_id' => $userId, 'role' => $newRole->value]]);
    }

    /**
     * Workspace-scoped + alive rooms only: WorkspaceScope needs the context
     * set, which happens after SubstituteBindings — resolve explicitly here
     * so cross-workspace and soft-deleted ids both land on 404.
     */
    private function roomOrFail(string $roomId): Room
    {
        return Room::query()
            ->whereNull('deleted_at')
            ->findOrFail($roomId);
    }

    /**
     * Active membership or 403 ROOM_NOT_MEMBER.
     */
    private function requireMembership(Room $room, User $user): RoomMember
    {
        return $this->policy->membership($room, $user)
            ?? throw ApiException::roomNotMember();
    }

    /**
     * @param  array<int, mixed>  $rows  Room or stdlib join rows carrying room + pivot columns
     * @return array<int, array<string, mixed>>
     */
    private function summarize(array $rows, string $userId, ?RoomMember $membership = null): array
    {
        $roomIds = collect($rows)->map(fn ($row) => $row->id ?? $row->room_id)->all();

        // last messages + dm counterparts + mute settings in three batched queries
        $lastMessages = Message::query()
            ->with('attachments')
            ->whereIn('id', collect($rows)->map(fn ($row) => $row->last_message_id)->filter()->all())
            ->get()
            ->keyBy('id');

        $dmOthers = collect();
        $dmIds = collect($rows)->filter(fn ($row) => ($row->type instanceof RoomType ? $row->type : RoomType::from($row->type)) === RoomType::Dm)
            ->map(fn ($row) => $row->id)
            ->values();

        if ($dmIds->isNotEmpty()) {
            $dmOthers = RoomMember::query()
                ->whereIn('room_members.room_id', $dmIds->all())
                ->whereNull('room_members.left_at')
                ->where('room_members.user_id', '!=', $userId)
                ->join('users', 'users.id', '=', 'room_members.user_id')
                ->get(['room_members.room_id', 'users.id', 'users.username', 'users.display_name', 'users.avatar_attachment_id', 'users.last_seen_at'])
                ->groupBy('room_id');
        }

        $muted = RoomNotificationSetting::query()
            ->where('user_id', $userId)
            ->whereIn('room_id', $roomIds)
            ->get()
            ->keyBy('room_id');

        $offlineAfter = $this->settings->int('presence.offline_after_seconds');

        return collect($rows)->map(function ($row) use ($lastMessages, $dmOthers, $muted, $offlineAfter, $membership) {
            $type = $row->type instanceof RoomType ? $row->type : RoomType::from($row->type);
            $lastSeq = (int) $row->last_seq;
            $lastRead = (int) ($row->my_last_read_seq ?? $membership?->last_read_seq ?? 0);
            $lastMessage = $row->last_message_id !== null ? $lastMessages->get($row->last_message_id) : null;
            $other = $type === RoomType::Dm ? ($dmOthers->get($row->id)?->first() ?? null) : null;
            $setting = $muted->get($row->id);

            return [
                'room' => [
                    'id' => $row->id,
                    'workspace_id' => $row->workspace_id,
                    'type' => $type->value,
                    'name' => $row->name,
                    'description' => $row->description,
                    'avatar_attachment_id' => $row->avatar_attachment_id,
                    'created_by' => $row->created_by,
                    'last_seq' => $lastSeq,
                    'member_count' => (int) $row->member_count,
                    'last_message_at' => $row->last_message_at !== null
                        ? Carbon::parse($row->last_message_at)->toIso8601String()
                        : null,
                ],
                'last_message' => $lastMessage !== null ? [
                    'id' => $lastMessage->id,
                    'type' => $lastMessage->type->value,
                    'body' => mb_substr($this->previewText($lastMessage), 0, 120),
                    'sender_id' => $lastMessage->sender_id,
                    'created_at' => $lastMessage->created_at?->toIso8601String(),
                ] : null,
                'unread_count' => max(0, $lastSeq - $lastRead),
                'my_role' => ($row->my_role !== null
                    ? RoomRole::from($row->my_role)
                    : ($membership?->role ?? RoomRole::Member))->value,
                'muted' => $setting !== null && ($setting->mode->value === 'none' || ($setting->muted_until !== null && $setting->muted_until->isFuture())),
                'other_user' => $other !== null ? [
                    'id' => $other->id,
                    'username' => $other->username,
                    'display_name' => $other->display_name,
                    'avatar_attachment_id' => $other->avatar_attachment_id,
                    'presence' => $other->last_seen_at !== null
                        && Carbon::parse($other->last_seen_at)->diffInSeconds(now()) < $offlineAfter ? 'online' : 'offline',
                ] : null,
            ];
        })->values()->all();
    }

    /**
     * Attachment-only messages preview as 📷/🎬/📎 in lists (FR-MSG-002).
     */
    private function previewText(Message $message): string
    {
        if ($message->body !== null && $message->body !== '') {
            return $message->body;
        }

        return match ($message->type) {
            MessageType::Image => '📷 รูปภาพ',
            MessageType::Video => '🎬 วิดีโอ',
            MessageType::File => '📎 '.($message->attachments->first()?->original_name ?? 'ไฟล์'),
            default => '',
        };
    }
}
