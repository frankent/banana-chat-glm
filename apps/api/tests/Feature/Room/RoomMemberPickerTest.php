<?php

use App\Enums\RoomRole;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;

/**
 * TC-ROOM-097..100 — GET /members?room_id= adds `in_room` so the add-members
 * picker can grey out people already in the group (FR-ROOM-004, DEC-096).
 * Helper names are unique: Pest helpers are global across test files.
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony', 'display_name' => 'Tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai']);
    $this->anna = User::factory()->create(['username' => 'anna', 'display_name' => 'Anna']);
    $this->ghost = User::factory()->create(['username' => 'ghost', 'display_name' => 'Ghost']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws2 = Workspace::factory()->create(['slug' => 'globex']);
    foreach ([$this->tony, $this->somchai, $this->anna, $this->ghost] as $u) {
        $this->ws->members()->attach($u->id, ['role' => 'member']);
    }
    $this->ws2->members()->attach($this->tony->id, ['role' => 'member']);

    $this->room = pickerGroup($this->ws, $this->tony, [$this->somchai]);
});

function pickerGroup(Workspace $ws, User $owner, array $members): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id, 'type' => 'group', 'name' => 'Picker',
        'created_by' => $owner->id, 'owner_id' => $owner->id,
        'member_count' => count($members) + 1, 'last_message_at' => now(),
    ]);
    foreach ([$owner, ...$members] as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $room->id, 'user_id' => $user->id, 'workspace_id' => $ws->id,
            'role' => $i === 0 ? RoomRole::Owner : RoomRole::Member, 'added_by' => $owner->id,
        ]);
    }

    return $room;
}

test('TC-ROOM-097 room_id flags exactly the active room members as in_room; without room_id the key is absent', function () {
    [, $token] = loginAs($this->tony);

    $rows = collect($this->getJson("/api/v1/members?room_id={$this->room->id}", wsHeaders($token, 'acme'))
        ->assertOk()->json('data'))->keyBy('username');
    expect($rows['tony']['in_room'])->toBeTrue()
        ->and($rows['somchai']['in_room'])->toBeTrue()
        ->and($rows['anna']['in_room'])->toBeFalse()
        ->and($rows['ghost']['in_room'])->toBeFalse();

    // the UI pages through /directory, which wraps the same query
    $viaDirectory = collect($this->getJson("/api/v1/directory?room_id={$this->room->id}", wsHeaders($token, 'acme'))
        ->assertOk()->json('data.members'))->keyBy('username');
    expect($viaDirectory['somchai']['in_room'])->toBeTrue()->and($viaDirectory['anna']['in_room'])->toBeFalse();

    $plain = collect($this->getJson('/api/v1/members', wsHeaders($token, 'acme'))->assertOk()->json('data'));
    expect($plain->every(fn ($row) => ! array_key_exists('in_room', $row)))->toBeTrue();
});

test('TC-ROOM-098 a member who left the room is NOT in_room, and search composes with room_id', function () {
    RoomMember::query()->where('room_id', $this->room->id)->where('user_id', $this->somchai->id)->update(['left_at' => now()]);
    [, $token] = loginAs($this->tony);

    $rows = $this->getJson("/api/v1/members?room_id={$this->room->id}&q=SOM", wsHeaders($token, 'acme'))
        ->assertOk()->json('data');
    expect($rows)->toHaveCount(1)
        ->and($rows[0]['username'])->toBe('somchai')
        ->and($rows[0]['in_room'])->toBeFalse();
});

test('TC-ROOM-099 room_id of a room the caller is not in → 403 ROOM_NOT_MEMBER; unknown / other-workspace / non-ulid → 404 / 422', function () {
    [, $token] = loginAs($this->anna);
    $this->getJson("/api/v1/members?room_id={$this->room->id}", wsHeaders($token, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');

    [, $tonyToken] = loginAs($this->tony);
    $this->getJson("/api/v1/members?room_id={$this->room->id}", wsHeaders($tonyToken, 'globex'))->assertStatus(404);
    $this->getJson('/api/v1/members?room_id=01HZZZZZZZZZZZZZZZZZZZZZZZ', wsHeaders($tonyToken, 'acme'))->assertStatus(404);
    $this->getJson('/api/v1/members?room_id=nope', wsHeaders($tonyToken, 'acme'))->assertStatus(422);
});

test('TC-ROOM-100 picker round trip: someone not in the group is found via search and added; the flag flips', function () {
    [, $token] = loginAs($this->tony);
    $h = wsHeaders($token, 'acme');

    $found = $this->getJson("/api/v1/members?room_id={$this->room->id}&q=ann", $h)->assertOk()->json('data');
    expect($found)->toHaveCount(1)->and($found[0]['in_room'])->toBeFalse();

    $this->postJson("/api/v1/rooms/{$this->room->id}/members", ['user_ids' => [$found[0]['id']]], $h)
        ->assertOk()->assertJsonPath('data.added', 1)->assertJsonPath('data.already', 0);

    $after = $this->getJson("/api/v1/members?room_id={$this->room->id}&q=ann", $h)->json('data');
    expect($after[0]['in_room'])->toBeTrue()
        ->and($this->room->refresh()->member_count)->toBe(3);
});
