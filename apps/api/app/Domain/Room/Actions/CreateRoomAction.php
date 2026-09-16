<?php

namespace App\Domain\Room\Actions;

use App\Domain\Room\SystemMessageWriter;
use App\Enums\MemberStatus;
use App\Enums\RoomRole;
use App\Enums\RoomType;
use App\Enums\UserStatus;
use App\Events\RoomCreated;
use App\Exceptions\ApiException;
use App\Jobs\ExpireSecretRooms;
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
 * FR-ROOM-001/002/012 — DM via dm_key dedupe (200) or create (201);
 * group with creator as owner + member_added system message at seq 1.
 *
 * Secret rooms ($expiryDays 1..30): a separate namespace — a secret DM never
 * dedupes onto the canonical DM between the same pair, and the expiry clock
 * starts at creation (DEC-056). Expiry is the only "secret" property: content
 * is transported/stored exactly like ordinary rooms.
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

    public function createDm(User $actor, string $targetUserId, ?int $expiryDays = null): array
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

        $dmKey = $this->dmKey($actor->id, $targetUserId, $expiryDays !== null);

        $existing = Room::query()
            ->where('dm_key', $dmKey)
            ->whereNull('deleted_at')
            ->first();

        if ($existing !== null && ! $existing->isExpired()) {
            return [$existing, false];
        }

        try {
            $room = DB::transaction(function () use ($actor, $targetUserId, $dmKey, $expiryDays): Room {
                return $this->insertDm($actor, $targetUserId, $dmKey, $expiryDays);
            });
        } catch (UniqueConstraintViolationException) {
            // race: the other party created the same room first — return theirs
            $existing = Room::query()->where('dm_key', $dmKey)->whereNull('deleted_at')->firstOrFail();

            if (! $existing->isExpired()) {
                return [$existing, false];
            }

            // an expired-but-not-yet-swept room still pins the unique key —
            // run the idempotent expiry cleanup, then retry the insert once
            app(ExpireSecretRooms::class)->expireRoom($existing);

            $room = DB::transaction(function () use ($actor, $targetUserId, $dmKey, $expiryDays): Room {
                return $this->insertDm($actor, $targetUserId, $dmKey, $expiryDays);
            });
        }

        $this->audit->log('room.created', actor: $actor, targetType: 'room', targetId: $room->id, context: $expiryDays !== null ? ['secret' => true, 'expiry_days' => $expiryDays] : []);
        broadcast(new RoomCreated($room))->toOthers();

        return [$room, true];
    }

    public function createGroup(User $actor, string $name, ?string $description, array $memberIds, ?int $expiryDays = null): array
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

        $room = DB::transaction(function () use ($actor, $name, $description, $memberIds, $expiryDays): Room {
            $room = Room::query()->create([
                'workspace_id' => $this->context->id(),
                'type' => RoomType::Group,
                'name' => $name,
                'description' => $description,
                'created_by' => $actor->id,
                'owner_id' => $actor->id,
                'member_count' => count($memberIds) + 1,
                'is_secret' => $expiryDays !== null,
                'secret_expires_at' => $expiryDays !== null ? now()->addDays($expiryDays) : null,
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

        $this->audit->log('room.created', actor: $actor, targetType: 'room', targetId: $room->id, context: $expiryDays !== null ? ['secret' => true, 'expiry_days' => $expiryDays] : []);
        broadcast(new RoomCreated($room));

        return [$room, true];
    }

    private function insertDm(User $actor, string $targetUserId, string $dmKey, ?int $expiryDays): Room
    {
        $room = Room::query()->create([
            'workspace_id' => $this->context->id(),
            'type' => RoomType::Dm,
            'name' => null,
            'dm_key' => $dmKey,
            'created_by' => $actor->id,
            'owner_id' => null,
            'member_count' => 2,
            'last_message_at' => now(),
            'is_secret' => $expiryDays !== null,
            'secret_expires_at' => $expiryDays !== null ? now()->addDays($expiryDays) : null,
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
    }

    private function dmKey(string $a, string $b, bool $secret): string
    {
        $ids = [$a, $b];
        sort($ids);

        // FR-ROOM-012 — secret DMs live in their own namespace so they never
        // merge with (or evict) the canonical ordinary DM (DEC-056)
        return hash('sha256', ($secret ? 'secret:' : '').implode(',', $ids));
    }
}
