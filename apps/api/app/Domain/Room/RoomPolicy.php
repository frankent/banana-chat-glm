<?php

namespace App\Domain\Room;

use App\Enums\RoomRole;
use App\Enums\WorkspaceRole;
use App\Exceptions\ApiException;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Support\WorkspaceContext;

/**
 * §6.2 room-group permissions + §6.1 workspace-level overrides.
 * DM (§6.3): both parties equal — no add/remove/delete/owner.
 */
class RoomPolicy
{
    public function __construct(
        private readonly WorkspaceContext $context,
    ) {}

    public function membership(Room $room, User $user): ?RoomMember
    {
        return RoomMember::query()
            ->where('room_id', $room->id)
            ->where('user_id', $user->id)
            ->whereNull('left_at')
            ->first();
    }

    public function membershipOrFail(Room $room, User $user): RoomMember
    {
        return $this->membership($room, $user)
            ?? throw ApiException::roomNotMember();
    }

    private function wsRoleRank(): int
    {
        return $this->context->membership()?->role?->rank() ?? 0;
    }

    /**
     * §6.1 — workspace admin/owner or system admin outranks any room role.
     */
    private function isWsAdmin(User $user): bool
    {
        return $user->is_system_admin
            || $this->wsRoleRank() >= WorkspaceRole::Admin->rank();
    }

    public function canManageEverything(User $user): bool
    {
        return $this->isWsAdmin($user);
    }

    /**
     * Room admin+ (or ws admin+): edit settings json, remove members, set admins.
     */
    public function isRoomAdmin(?RoomMember $membership, User $user): bool
    {
        return $this->isWsAdmin($user)
            || ($membership?->role?->atLeast(RoomRole::Admin) ?? false);
    }

    public function isRoomOwner(?RoomMember $membership, User $user): bool
    {
        return $user->is_system_admin
            || $membership?->role === RoomRole::Owner
            || $this->context->membership()?->role === WorkspaceRole::Owner;
    }

    /**
     * FR-ROOM-004 — POST members: gated by room setting who_can_add_members.
     */
    public function assertCanAddMembers(Room $room, RoomMember $actor): void
    {
        if ($room->isDm()) {
            throw ApiException::roomDmImmutable();
        }

        $setting = $room->settings['who_can_add_members'] ?? 'everyone';
        if ($setting === 'everyone') {
            return; // any active member
        }

        if (! $this->isRoomAdmin($actor, $this->contextUser())) {
            throw ApiException::roomForbidden();
        }
    }

    /**
     * FR-ROOM-004 — DELETE member: room owner/admin; owner untouchable;
     * removing another admin requires room owner or ws owner/SA.
     */
    public function assertCanRemoveMember(Room $room, RoomMember $actor, RoomMember $target): void
    {
        if ($room->isDm()) {
            throw ApiException::roomDmImmutable();
        }

        if ($target->role === RoomRole::Owner) {
            throw ApiException::roomForbidden();
        }

        if (! $this->isRoomAdmin($actor, $this->contextUser())) {
            throw ApiException::roomForbidden();
        }

        if ($target->role === RoomRole::Admin && ! $this->isRoomOwner($actor, $this->contextUser())) {
            throw ApiException::roomForbidden();
        }
    }

    /**
     * FR-ROOM-007 — PATCH room: info gated by who_can_edit_info,
     * settings json owner/admin only.
     */
    public function assertCanEditInfo(Room $room, RoomMember $actor, bool $touchesSettings): void
    {
        if ($touchesSettings) {
            if (! $this->isRoomAdmin($actor, $this->contextUser())) {
                throw ApiException::roomForbidden();
            }

            return;
        }

        $setting = $room->settings['who_can_edit_info'] ?? 'everyone';
        if ($setting === 'admins' && ! $this->isRoomAdmin($actor, $this->contextUser())) {
            throw ApiException::roomForbidden();
        }
    }

    /**
     * FR-ROOM-006 — role changes:
     * owner sets owner (self → admin); owner/admin set/unset admin;
     * admin cannot unset another admin.
     */
    public function assertCanChangeRole(Room $room, RoomMember $actor, RoomMember $target, RoomRole $newRole): void
    {
        $actorUser = $this->contextUser();
        $actorIsAdmin = $this->isRoomAdmin($actor, $actorUser);
        $actorIsOwner = $this->isRoomOwner($actor, $actorUser);

        if (! $actorIsAdmin) {
            throw ApiException::roomForbidden();
        }

        // Demoting an admin (admin→member) requires owner
        if ($target->role === RoomRole::Admin
            && $newRole === RoomRole::Member
            && ! $actorIsOwner) {
            throw ApiException::roomForbidden();
        }

        // Only owner (or ws owner/SA) may assign ownership
        if ($newRole === RoomRole::Owner && ! $actorIsOwner) {
            throw ApiException::roomForbidden();
        }
    }

    /**
     * FR-ROOM-008 — DELETE room: group only; room owner or ws admin+ or SA.
     */
    public function assertCanDelete(Room $room, ?RoomMember $actor): void
    {
        if ($room->isDm()) {
            throw ApiException::roomDmImmutable();
        }

        if (! $this->isRoomOwner($actor, $this->contextUser())
            && ! $this->isWsAdmin($this->contextUser())) {
            throw ApiException::roomForbidden();
        }
    }

    private function contextUser(): User
    {
        return auth('api')->user() ?? throw ApiException::roomNotMember();
    }
}
