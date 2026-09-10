<?php

namespace App\Domain\Admin;

use App\Domain\Room\SystemMessageWriter;
use App\Enums\MemberStatus;
use App\Enums\RoomRole;
use App\Events\RoomMemberRemoved;
use App\Events\WorkspaceMembershipChanged;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Illuminate\Support\Facades\DB;

/** FR-ADM-005/006: one path for both sides of the membership UI. */
class WorkspaceMembershipService
{
    public function assign(User $actor, Workspace $workspace, User $user, string $role): WorkspaceMember
    {
        app(ModerationService::class)->authorize($actor);
        abort_unless(in_array($role, ['owner', 'admin', 'member'], true), 422);

        return DB::transaction(function () use ($actor, $workspace, $user, $role) {
            $membership = WorkspaceMember::updateOrCreate(['workspace_id' => $workspace->id, 'user_id' => $user->id], ['role' => $role, 'status' => 'active', 'removed_at' => null, 'invited_by' => $actor->id]);
            app(AuditLogger::class)->log('workspace.member_added', $actor, 'workspace', $workspace->id, ['user_id' => $user->id, 'role' => $role], $workspace->id);
            DB::afterCommit(fn () => broadcast(new WorkspaceMembershipChanged($membership, 'workspace.member_added')));

            return $membership;
        });
    }

    public function remove(User $actor, WorkspaceMember $membership): void
    {
        app(ModerationService::class)->authorize($actor);
        DB::transaction(function () use ($actor, $membership) {
            $membership = WorkspaceMember::lockForUpdate()->findOrFail($membership->id);
            if ($membership->status === MemberStatus::Removed) {
                return;
            }
            $membership->update(['status' => 'removed', 'removed_at' => now()]);
            foreach (RoomMember::where('workspace_id', $membership->workspace_id)->where('user_id', $membership->user_id)->whereNull('left_at')->get() as $rm) {
                $room = Room::lockForUpdate()->findOrFail($rm->room_id);
                $rm->update(['left_at' => now()]);
                $remaining = $room->memberships()->whereNull('left_at')->get();
                $room->forceFill(['member_count' => $remaining->count()])->save();
                if (! $room->isDm() && $room->owner_id === $membership->user_id && $remaining->isNotEmpty()) {
                    $next = $remaining->sortBy(fn ($m) => ($m->role === RoomRole::Admin ? '0' : '1').$m->joined_at?->toIso8601String().$m->id)->first();
                    $next->update(['role' => 'owner']);
                    $room->update(['owner_id' => $next->user_id]);
                }
                app(SystemMessageWriter::class)->write($room, $actor, 'member_removed', ['user_id' => $membership->user_id]);
                if ($remaining->isEmpty() && ! $room->deleted_at) {
                    app(ModerationService::class)->deleteRoom($actor, $room);
                }
                DB::afterCommit(fn () => broadcast(new RoomMemberRemoved($room->refresh(), $membership->user_id, $actor->id, 'removed')));
            }
            app(AuditLogger::class)->log('workspace.member_removed', $actor, 'workspace', $membership->workspace_id, ['user_id' => $membership->user_id], $membership->workspace_id);
            DB::afterCommit(fn () => broadcast(new WorkspaceMembershipChanged($membership, 'workspace.member_removed')));
        });
    }
}
