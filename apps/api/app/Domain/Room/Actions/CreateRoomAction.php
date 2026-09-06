<?php

namespace App\Domain\Room\Actions;

use App\Domain\Room\SystemMessageWriter;
use App\Enums\MemberStatus;
use App\Enums\RoomRole;
use App\Enums\RoomType;
use App\Enums\UserStatus;
use App\Events\RoomCreated;
use App\Exceptions\ApiException;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * FR-ROOM-001/002 — DM via dm_key dedupe (200) or create (201);
 * group with creator as owner + member_added system message at seq 1.
 *
 * @return array{0: Room, 1: bool} [room, created]
 */
class CreateRoomAction
{
    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly SettingsService $settings,
        private readonly SystemMessageWriter $systemMessages,
        private readonly AuditLogger $audit,
    ) {}

    public function createDm(User $actor, string $targetUserId): array
    {
        if ($actor->id === $targetUserId) {
            throw ApiException::roomDmSelf();
        }

        // target must be an active member of the current workspace (404, no leak)
        $targetActive = WorkspaceMember::query()
            ->where('workspace_members.workspace_id', $this->context->id())
            ->where('workspace_members.user_id', $targetUserId)
            ->where('workspace_members.status', MemberStatus::Active)
            ->join('users', 'users.id', '=', 'workspace_members.user_id')
            ->where('users.status', '!=', UserStatus::Deactivated)
            ->exists();

        if (! $targetActive) {
            abort(404);
        }

        $dmKey = $this->dmKey($actor->id, $targetUserId);

        $existing = Room::query()
            ->where('dm_key', $dmKey)
            ->whereNull('deleted_at')
            ->first();

        if ($existing !== null) {
            return [$existing, false];
        }

        try {
            $room = DB::transaction(function () use ($actor, $targetUserId, $dmKey): Room {
                $room = Room::query()->create([
                    'workspace_id' => $this->context->id(),
                    'type' => RoomType::Dm,
                    'name' => null,
                    'dm_key' => $dmKey,
                    'created_by' => $actor->id,
                    'owner_id' => null,
                    'member_count' => 2,
                    'last_message_at' => now(),
                ]);

                foreach ([$actor->id, $targetUserId] as $userId) {
                    RoomMember::query()->create([
                        'room_id' => $room->id,
                        'user_id' => $userId,
                        'workspace_id' => $room->workspace_id,
                        'role' => RoomRole::Member,
                        'added_by' => $actor->id,
                    ]);
                }

                return $room;
            });
        } catch (UniqueConstraintViolationException) {
            // race: the other party created the same DM first — return theirs
            return [Room::query()->where('dm_key', $dmKey)->whereNull('deleted_at')->firstOrFail(), false];
        }

        $this->audit->log('room.created', actor: $actor, targetType: 'room', targetId: $room->id);
        broadcast(new RoomCreated($room))->toOthers();

        return [$room, true];
    }

    public function createGroup(User $actor, string $name, ?string $description, array $memberIds): array
    {
        $name = trim($name);
        $memberIds = array_values(array_unique(array_diff($memberIds, [$actor->id])));

        $maxMembers = $this->settings->int('room.group.max_members');

        if (count($memberIds) + 1 > $maxMembers) {
            throw ApiException::roomFull($maxMembers);
        }

        if ($memberIds !== []) {
            $valid = WorkspaceMember::query()
                ->where('workspace_members.workspace_id', $this->context->id())
                ->where('workspace_members.status', MemberStatus::Active)
                ->whereIn('workspace_members.user_id', $memberIds)
                ->join('users', 'users.id', '=', 'workspace_members.user_id')
                ->where('users.status', '!=', UserStatus::Deactivated)
                ->pluck('workspace_members.user_id');

            if ($valid->count() !== count($memberIds)) {
                throw ApiException::roomForbidden();
            }
        }

        $room = DB::transaction(function () use ($actor, $name, $description, $memberIds): Room {
            $room = Room::query()->create([
                'workspace_id' => $this->context->id(),
                'type' => RoomType::Group,
                'name' => $name,
                'description' => $description,
                'created_by' => $actor->id,
                'owner_id' => $actor->id,
                'member_count' => count($memberIds) + 1,
            ]);

            RoomMember::query()->create([
                'room_id' => $room->id,
                'user_id' => $actor->id,
                'workspace_id' => $room->workspace_id,
                'role' => RoomRole::Owner,
                'added_by' => $actor->id,
            ]);

            foreach ($memberIds as $userId) {
                RoomMember::query()->create([
                    'room_id' => $room->id,
                    'user_id' => $userId,
                    'workspace_id' => $room->workspace_id,
                    'role' => RoomRole::Member,
                    'added_by' => $actor->id,
                ]);
            }

            return $room;
        });

        // FR-ROOM-002: system message member_added is the first seq
        $this->systemMessages->write($room, $actor, 'member_added', [
            'user_ids' => [$actor->id, ...$memberIds],
        ]);
        $room->refresh();

        $this->audit->log('room.created', actor: $actor, targetType: 'room', targetId: $room->id);
        broadcast(new RoomCreated($room));

        return [$room, true];
    }

    private function dmKey(string $a, string $b): string
    {
        $ids = [$a, $b];
        sort($ids);

        return hash('sha256', implode(',', $ids));
    }
}
