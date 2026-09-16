<?php

use App\Models\PublicChatRoom;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\WorkspaceMember;
use Illuminate\Support\Facades\Broadcast;

/*
|--------------------------------------------------------------------------
| Broadcast channels — spec §9.2
|--------------------------------------------------------------------------
*/

// private-room.{rid} — active members only (left/removed lose access
// immediately); expired secret rooms deny realtime too (FR-ROOM-012)
Broadcast::channel('room.{roomId}', function (User $user, string $roomId) {
    $room = Room::withoutGlobalScopes()
        ->whereNull('deleted_at')
        ->find($roomId);

    if ($room === null || $room->isExpired()) {
        return false;
    }

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

/*
|--------------------------------------------------------------------------
| PUBLIC CHAT — FR-PCHAT-016 / DEC-065. TWO CHANNELS, ONE BOUNDARY.
|--------------------------------------------------------------------------
|
| private-public-chat.{roomId}        visitor + agents; PUBLIC payload only
| private-public-chat-staff.{roomId}  agents only;      INTERNAL payload
|
| BOTH ARE KEYED BY THE ROOM ULID AND NEVER BY THE 64-HEX CODE. A Pusher
| channel name is public by construction — it travels in every WebSocket
| subscribe frame, in the pusher:subscription_succeeded echo, in browser
| devtools, and (because RealtimeEvent is ShouldBroadcast, not
| ShouldBroadcastNow) through queued jobs and failed_jobs payloads. Putting the
| visitor's credential there would undo every other precaution.
|
| These callbacks authorise AGENTS. The VISITOR side is API-215
| (PublicChatVisitorController::broadcastAuth) and is reachable only for
| 'private-public-chat.'.{their own room id} — the -staff channel is not
| derivable from any visitor input and this file is the only thing that grants
| it.
|
| The existing room.{roomId} callback above is deliberately NOT modified: public
| chat rooms are not `rooms` rows, so support agents never meet the RoomMember
| gate that would otherwise deny them under Decision A.
*/

/**
 * ONE shared membership test for both channels, as a CLOSURE rather than a named
 * function: routes/channels.php is loaded more than once in a test process, and
 * a named function would be a fatal redeclaration.
 *
 * withoutGlobalScopes() is REQUIRED here, not tidy: channel authorisation runs
 * with NO workspace context, and WorkspaceScope::apply() no-ops silently when
 * the context is unset — so the scope would neither protect nor filter. The
 * membership query is the real gate, and it reuses the workspace-member test
 * written verbatim for the workspace.{workspaceId} callback above.
 *
 * Expiry is deliberately NOT checked: an expired link locks the VISITOR out
 * (every Tier-2 route answers 410), but agents must keep their realtime view of
 * a conversation they may still be closing out. A soft-deleted room IS refused.
 *
 * @return array{id: string, username: string, display_name: string}|false
 */
$publicChatChannelMember = function (User $user, string $roomId): array|false {
    $room = PublicChatRoom::withoutGlobalScopes()
        ->whereNull('deleted_at')
        ->find($roomId);

    if ($room === null) {
        return false;
    }

    return WorkspaceMember::query()
        ->withoutGlobalScopes()
        ->where('workspace_id', $room->workspace_id)
        ->where('user_id', $user->id)
        ->where('status', 'active')
        ->exists()
        ? ['id' => $user->id, 'username' => $user->username, 'display_name' => $user->display_name]
        : false;
};

/**
 * Agent mirroring of the customer-visible stream. Same membership test as the
 * staff channel — the split is about WHICH PAYLOAD travels where, not about who
 * may listen.
 */
Broadcast::channel('public-chat.{roomId}', $publicChatChannelMember);

/** Internal payload: active workspace members only. */
Broadcast::channel('public-chat-staff.{roomId}', $publicChatChannelMember);
