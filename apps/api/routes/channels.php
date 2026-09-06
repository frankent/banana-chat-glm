<?php

use App\Models\RoomMember;
use App\Models\User;
use App\Models\WorkspaceMember;
use Illuminate\Support\Facades\Broadcast;

/*
|--------------------------------------------------------------------------
| Broadcast channels — spec §9.2
|--------------------------------------------------------------------------
*/

// private-room.{rid} — active members only (left/removed lose access immediately)
Broadcast::channel('room.{roomId}', function (User $user, string $roomId) {
    $member = RoomMember::query()
        ->where('room_id', $roomId)
        ->where('user_id', $user->id)
        ->whereNull('left_at')
        ->first();

    return $member !== null ? [
        'id' => $user->id,
        'username' => $user->username,
        'display_name' => $user->display_name,
        'role' => $member->role->value,
    ] : false;
});

// private-user.{uid} — own channel only
Broadcast::channel('user.{userId}', function (User $user, string $userId) {
    return $user->id === $userId
        ? ['id' => $user->id, 'username' => $user->username]
        : false;
});

// private-workspace.{wid} + presence-workspace.{wid} — active members
Broadcast::channel('workspace.{workspaceId}', function (User $user, string $workspaceId) {
    return WorkspaceMember::query()
        ->where('workspace_id', $workspaceId)
        ->where('user_id', $user->id)
        ->where('status', 'active')
        ->exists()
        ? ['id' => $user->id, 'username' => $user->username, 'display_name' => $user->display_name]
        : false;
});
