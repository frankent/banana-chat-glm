<?php

use App\Enums\RoomRole;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Testing\TestResponse;

/**
 * TC-RT-001..003 — channel authorization via POST /broadcasting/auth
 * (FR-RT-001/002, NFR-SEC-006: no room data to non-members).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);
    $this->outsider = User::factory()->create(['username' => 'outsider']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);

    $this->room = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 2,
        'last_message_at' => now(),
    ]);

    foreach ([$this->tony, $this->somchai] as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $i === 0 ? RoomRole::Owner : RoomRole::Member,
            'added_by' => $this->tony->id,
        ]);
    }
});

function authChannel($test, string $token, string $channel): TestResponse
{
    return $test->postJson('/api/v1/broadcasting/auth', [
        'socket_id' => '1234.5678',
        'channel_name' => $channel,
    ], authHeaders($token));
}

test('TC-RT-001 active room member can authorize private-room channel', function () {
    [$user, $token] = loginAs($this->somchai);

    authChannel($this, $token, "private-room.{$this->room->id}")
        ->assertStatus(200)
        ->assertJsonStructure(['auth']); // private channels: auth only (channel_data is presence-only)
});

test('TC-RT-002 non-member cannot authorize private-room channel → 403', function () {
    [$user, $token] = loginAs($this->outsider);

    authChannel($this, $token, "private-room.{$this->room->id}")
        ->assertStatus(403);
});

test('left members lose private-room authorization', function () {
    RoomMember::query()->where('room_id', $this->room->id)->where('user_id', $this->somchai->id)
        ->update(['left_at' => now()]);

    [$user, $token] = loginAs($this->somchai);

    authChannel($this, $token, "private-room.{$this->room->id}")
        ->assertStatus(403);
});

test('TC-RT-003 private-user channel of another user → 403', function () {
    [$user, $token] = loginAs($this->tony);

    authChannel($this, $token, "private-user.{$this->somchai->id}")
        ->assertStatus(403);

    authChannel($this, $token, "private-user.{$this->tony->id}")
        ->assertStatus(200);
});

test('workspace channel requires active membership', function () {
    [$user, $token] = loginAs($this->outsider);

    authChannel($this, $token, "private-workspace.{$this->ws->id}")
        ->assertStatus(403);

    $this->ws->members()->attach($this->outsider->id, ['role' => 'member']);
    authChannel($this, $token, "private-workspace.{$this->ws->id}")
        ->assertStatus(200);
});

test('unauthenticated socket auth → 401', function () {
    $this->postJson('/api/v1/broadcasting/auth', [
        'socket_id' => '1234.5678',
        'channel_name' => "private-room.{$this->room->id}",
    ])->assertStatus(401);
});
