<?php

use App\Enums\RoomRole;
use App\Events\RoomDeleted;
use App\Events\RoomMemberAdded;
use App\Events\RoomMemberRemoved;
use App\Events\RoomUpdated;
use App\Models\AuditLog;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Event;

/**
 * TC-ROOM-001..003, 007, 011, 013, 019, 021, 024..027, 040, 042, 043, 055
 * + §6.2/6.3 policy cells (FR-ROOM-001..008, TASK-BE-006).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);
    $this->anna = User::factory()->create(['username' => 'anna']);
    $this->outsider = User::factory()->create(['username' => 'globexowner']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws2 = Workspace::factory()->create(['slug' => 'globex']);

    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);
    $this->ws->members()->attach($this->anna->id, ['role' => 'admin']);
    $this->ws2->members()->attach($this->outsider->id, ['role' => 'owner']);
});

/**
 * Direct-model group room fixture (system-message path is tested via API).
 */
function makeGroup(Workspace $ws, User $owner, array $members = []): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $owner->id,
        'owner_id' => $owner->id,
        'member_count' => count($members) + 1,
        'last_message_at' => now(),
    ]);

    RoomMember::query()->create([
        'room_id' => $room->id,
        'user_id' => $owner->id,
        'workspace_id' => $ws->id,
        'role' => RoomRole::Owner,
        'added_by' => $owner->id,
    ]);

    foreach ($members as $user) {
        RoomMember::query()->create([
            'room_id' => $room->id,
            'user_id' => $user->id,
            'workspace_id' => $ws->id,
            'role' => RoomRole::Member,
            'added_by' => $owner->id,
        ]);
    }

    return $room;
}

test('TC-ROOM-001 create DM → 201 with two members', function () {
    [$user, $token] = loginAs($this->tony);

    $response = $this->postJson('/api/v1/rooms', [
        'type' => 'dm',
        'user_id' => $this->somchai->id,
    ], wsHeaders($token, 'acme'));

    $response->assertStatus(201)
        ->assertJsonPath('data.room.type', 'dm')
        ->assertJsonPath('data.other_user.id', $this->somchai->id);

    expect(RoomMember::query()->where('room_id', $response->json('data.room.id'))->count())->toBe(2);
});

test('TC-ROOM-002 existing DM → 200 with the same room id (dm_key dedupe)', function () {
    [$user, $token] = loginAs($this->tony);
    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $first = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'));

    // reverse direction finds the same room
    $second = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->tony->id], wsHeaders($somchaiToken, 'acme'));

    $second->assertStatus(200)
        ->assertJsonPath('data.room.id', $first->json('data.room.id'));
});

test('TC-ROOM-003 DM with self → 422 ROOM_DM_SELF', function () {
    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->tony->id], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_DM_SELF');
});

test('DM target outside workspace → 404 (no leak)', function () {
    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->outsider->id], wsHeaders($token, 'acme'))
        ->assertStatus(404);
});

test('TC-ROOM-007 create group → 201, creator owner, member_added system message at seq 1', function () {
    [$user, $token] = loginAs($this->tony);

    $response = $this->postJson('/api/v1/rooms', [
        'type' => 'group',
        'name' => 'Engineering',
        'member_ids' => [$this->somchai->id],
    ], wsHeaders($token, 'acme'));

    $response->assertStatus(201)
        ->assertJsonPath('data.room.type', 'group')
        ->assertJsonPath('data.my_role', 'owner');

    $roomId = $response->json('data.room.id');

    $system = Message::query()->where('room_id', $roomId)->where('type', 'system')->first();
    expect($system->seq)->toBe(1)
        ->and($system->system_event['event'])->toBe('member_added');

    expect(RoomMember::query()->where('room_id', $roomId)->where('user_id', $this->somchai->id)->whereNull('left_at')->exists())->toBeTrue();
});

test('TC-ROOM-011 group over max_members → 422 ROOM_FULL', function () {
    app(SettingsService::class)->set('room.group.max_members', 2);

    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/rooms', [
        'type' => 'group',
        'name' => 'Too Big',
        'member_ids' => [$this->somchai->id, $this->anna->id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_FULL');
});

test('TC-ROOM-013 room list ordered last_message_at desc with unread_count', function () {
    $old = makeGroup($this->ws, $this->tony, [$this->somchai]);
    $old->forceFill(['last_message_at' => now()->subHour()])->save();

    $new = makeGroup($this->ws, $this->tony);
    $new->forceFill(['last_message_at' => now()])->save();

    // somchai has unread 0 in $old... he was never read; advance seq so unread exists
    $old->forceFill(['last_seq' => 5, 'last_user_seq' => 5])->save();

    [$user, $token] = loginAs($this->tony);

    $response = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'));

    $response->assertOk();
    $ids = collect($response->json('data'))->pluck('room.id');

    expect($ids->first())->toBe($new->id)
        ->and($ids->values()->get(1))->toBe($old->id);

    $oldEntry = collect($response->json('data'))->first(fn ($r) => $r['room']['id'] === $old->id);
    expect($oldEntry['unread_count'])->toBe(5); // tony last_read_seq=0 < last_seq=5
});

test('room list filter=unread returns only unread rooms', function () {
    $read = makeGroup($this->ws, $this->tony);
    $read->forceFill(['last_seq' => 3, 'last_message_at' => now()])->save();

    $unread = makeGroup($this->ws, $this->tony);
    $unread->forceFill(['last_seq' => 3, 'last_message_at' => now()])->save();
    RoomMember::query()->where('room_id', $read->id)->where('user_id', $this->tony->id)->update(['last_read_seq' => 3]);

    [$user, $token] = loginAs($this->tony);

    $response = $this->getJson('/api/v1/rooms?filter=unread', wsHeaders($token, 'acme'));

    $ids = collect($response->json('data'))->pluck('room.id');
    expect($ids)->toContain($unread->id)
        ->and($ids)->not->toContain($read->id);
});

test('TC-ROOM-019 adding an existing member is idempotent — no dup row, no system message', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $response = $this->postJson("/api/v1/rooms/{$room->id}/members", [
        'user_ids' => [$this->somchai->id],
    ], wsHeaders($token, 'acme'));

    $response->assertOk()
        ->assertJsonPath('data.added', 0)
        ->assertJsonPath('data.already', 1);

    expect(RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->count())->toBe(1)
        ->and(Message::query()->where('room_id', $room->id)->where('type', 'system')->count())->toBe(0);
});

test('TC-ROOM-021 re-adding a left member rejoins with last_read_seq = current last_seq', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    $room->forceFill(['last_seq' => 7])->save();
    RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)
        ->update(['left_at' => now()->subMinute()]);

    [$user, $token] = loginAs($this->tony);

    $this->postJson("/api/v1/rooms/{$room->id}/members", [
        'user_ids' => [$this->somchai->id],
    ], wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.added', 1);

    $membership = RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->first();
    expect($membership->left_at)->toBeNull()
        ->and($membership->last_read_seq)->toBe(7);
});

test('TC-ROOM-024 remove member → left_at, member_removed system message, event', function () {
    Event::fake([RoomMemberRemoved::class]);
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $this->deleteJson("/api/v1/rooms/{$room->id}/members/{$this->somchai->id}", [], wsHeaders($token, 'acme'))
        ->assertStatus(204);

    $membership = RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->first();
    expect($membership->left_at)->not->toBeNull();

    $system = Message::query()->where('room_id', $room->id)->where('type', 'system')->first();
    expect($system->system_event['event'])->toBe('member_removed')
        ->and($system->system_event['user_id'])->toBe($this->somchai->id);

    Event::assertDispatched(RoomMemberRemoved::class);
});

test('TC-ROOM-025 adding members to a DM → 422 ROOM_DM_IMMUTABLE', function () {
    [$user, $token] = loginAs($this->tony);
    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'))
        ->assertStatus(201)->json('data.room.id');

    $this->postJson("/api/v1/rooms/{$dm}/members", ['user_ids' => [$this->anna->id]], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_DM_IMMUTABLE');
});

test('TC-ROOM-026 member leaves group → 204, membership closed', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai, $this->anna]);
    [$user, $token] = loginAs($this->somchai);

    $this->postJson("/api/v1/rooms/{$room->id}/leave", [], wsHeaders($token, 'acme'))
        ->assertStatus(204);

    expect(RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->whereNull('left_at')->exists())->toBeFalse()
        ->and($room->fresh()->member_count)->toBe(2);
});

test('TC-ROOM-027 owner leaving with others present → 422 ROOM_OWNER_CANNOT_LEAVE', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $this->postJson("/api/v1/rooms/{$room->id}/leave", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_OWNER_CANNOT_LEAVE');
});

test('owner leaving as last member soft-deletes the room', function () {
    $room = makeGroup($this->ws, $this->tony);
    [$user, $token] = loginAs($this->tony);

    $this->postJson("/api/v1/rooms/{$room->id}/leave", [], wsHeaders($token, 'acme'))
        ->assertStatus(204);

    $fresh = $room->fresh();
    expect($fresh->deleted_at)->not->toBeNull()
        ->and($fresh->purge_after)->not->toBeNull();
});

test('TC-ROOM-040 plain member deleting a group → 403 ROOM_FORBIDDEN', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->somchai);

    $this->deleteJson("/api/v1/rooms/{$room->id}", [], wsHeaders($token, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');
});

test('deleting a DM → 422 ROOM_DM_IMMUTABLE', function () {
    [$user, $token] = loginAs($this->tony);
    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'))
        ->assertStatus(201)->json('data.room.id');

    $this->deleteJson("/api/v1/rooms/{$dm}", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_DM_IMMUTABLE');
});

test('TC-ROOM-042/043 owner deletes → soft delete + room.deleted event + audit; APIs then 404; ws admin can delete too', function () {
    Event::fake([RoomDeleted::class]);
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $this->deleteJson("/api/v1/rooms/{$room->id}", [], wsHeaders($token, 'acme'))
        ->assertStatus(204);

    expect($room->fresh()->deleted_at)->not->toBeNull();
    Event::assertDispatched(RoomDeleted::class);
    expect(AuditLog::query()->where('action', 'room.deleted')->where('target_id', $room->id)->exists())->toBeTrue();

    // any room API now 404s
    $this->getJson("/api/v1/rooms/{$room->id}", wsHeaders($token, 'acme'))->assertStatus(404);

    // ws admin (anna) can delete another group
    $other = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$anna, $annaToken] = loginAs($this->anna);

    $this->deleteJson("/api/v1/rooms/{$other->id}", [], wsHeaders($annaToken, 'acme'))
        ->assertStatus(204);
});

test('TC-ROOM-055 room member list exposes role + joined_at', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $response = $this->getJson("/api/v1/rooms/{$room->id}/members", wsHeaders($token, 'acme'));

    $response->assertOk();
    $byUser = collect($response->json('data'))->keyBy('id');

    expect($byUser->get($this->tony->id)['role'])->toBe('owner')
        ->and($byUser->get($this->somchai->id)['role'])->toBe('member')
        ->and($byUser->get($this->somchai->id)['joined_at'])->not->toBeNull();
});

test('FR-ROOM-006 owner transfers ownership — target owner, actor admin, room.owner_id moves', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $this->patchJson("/api/v1/rooms/{$room->id}/members/{$this->somchai->id}", ['role' => 'owner'], wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.role', 'owner');

    expect($room->fresh()->owner_id)->toBe($this->somchai->id)
        ->and(RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->tony->id)->first()->role->value)->toBe('admin')
        ->and(RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->first()->role->value)->toBe('owner');
});

test('§6.2 member cannot set roles; admin cannot unset another admin', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai, $this->anna]);
    RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->anna->id)->update(['role' => 'admin']);

    [$somchai, $somchaiToken] = loginAs($this->somchai);
    $this->patchJson("/api/v1/rooms/{$room->id}/members/{$this->anna->id}", ['role' => 'member'], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');

    [$anna, $annaToken] = loginAs($this->anna);
    // anna (room admin) cannot unset herself... she CAN demote herself (own role) — target another admin instead
    RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->somchai->id)->update(['role' => 'admin']);

    $this->patchJson("/api/v1/rooms/{$room->id}/members/{$this->somchai->id}", ['role' => 'member'], wsHeaders($annaToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');
});

test('non-member of an existing room → 403 ROOM_NOT_MEMBER', function () {
    $room = makeGroup($this->ws, $this->tony);
    [$anna, $annaToken] = loginAs($this->anna); // ws admin, but NOT a room member

    $this->getJson("/api/v1/rooms/{$room->id}", wsHeaders($annaToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');
});

test('cross-workspace room id → 404 (never 403)', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);

    [$outsiderUser, $outsiderToken] = loginAs($this->outsider); // globex

    // room exists but belongs to acme — outsider asking from globex gets 404
    $this->getJson("/api/v1/rooms/{$room->id}", wsHeaders($outsiderToken, 'globex'))
        ->assertStatus(404);
});

test('acme member asking from the wrong workspace header → 404 too', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    $this->ws2->members()->attach($this->tony->id, ['role' => 'member']);

    [$user, $token] = loginAs($this->tony);

    $this->getJson("/api/v1/rooms/{$room->id}", wsHeaders($token, 'globex'))
        ->assertStatus(404);
});

test('FR-ROOM-007 rename → room_renamed system message + room.updated + audit', function () {
    Event::fake([RoomUpdated::class]);
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    [$user, $token] = loginAs($this->tony);

    $this->patchJson("/api/v1/rooms/{$room->id}", ['name' => 'Platform'], wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.name', 'Platform');

    $system = Message::query()->where('room_id', $room->id)->where('type', 'system')->first();
    expect($system->system_event['event'])->toBe('room_renamed')
        ->and($system->system_event['name'])->toBe('Platform');

    Event::assertDispatched(RoomUpdated::class);
    expect(AuditLog::query()->where('action', 'room.updated')->where('target_id', $room->id)->exists())->toBeTrue();
});

test('who_can_edit_info=admins blocks plain member from renaming', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    $room->forceFill(['settings' => ['who_can_edit_info' => 'admins']])->save();

    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $this->patchJson("/api/v1/rooms/{$room->id}", ['name' => 'Hax'], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');
});

test('settings json editable only by room admin+ (who_can_add_members)', function () {
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);

    [$somchai, $somchaiToken] = loginAs($this->somchai);
    $this->patchJson("/api/v1/rooms/{$room->id}", ['settings' => ['who_can_add_members' => 'admins']], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403);

    [$user, $token] = loginAs($this->tony);
    $this->patchJson("/api/v1/rooms/{$room->id}", ['settings' => ['who_can_add_members' => 'admins']], wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.settings.who_can_add_members', 'admins');
});

test('who_can_add_members=admins blocks plain member from adding', function () {
    Event::fake([RoomMemberAdded::class]);
    $room = makeGroup($this->ws, $this->tony, [$this->somchai]);
    $room->forceFill(['settings' => ['who_can_add_members' => 'admins']])->save();

    [$somchai, $somchaiToken] = loginAs($this->somchai);
    $this->postJson("/api/v1/rooms/{$room->id}/members", ['user_ids' => [$this->anna->id]], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403);

    Event::assertNotDispatched(RoomMemberAdded::class);
});
