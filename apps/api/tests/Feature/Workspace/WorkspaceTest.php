<?php

use App\Models\User;
use App\Models\Workspace;

/**
 * TC-WS-001..004, 008/009/012, 019..021 — workspace context & isolation.
 * (wsHeaders helper lives in tests/Pest.php.)
 */
beforeEach(function () {
    $this->owner = User::factory()->create(['username' => 'tony']);
    $this->member = User::factory()->create(['username' => 'somchai']);
    $this->other = User::factory()->create(['username' => ' outsider']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws2 = Workspace::factory()->create(['slug' => 'globex']);
    $this->ws->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);
    $this->ws2->members()->attach($this->other->id, ['role' => 'owner']);
});

test('TC-WS-001 me/workspaces lists active memberships with role', function () {
    [$user, $token] = loginAs($this->owner);

    $response = $this->getJson('/api/v1/me/workspaces', authHeaders($token));

    $response->assertOk();
    expect(collect($response->json('data'))->pluck('workspace.slug'))->toContain('acme')
        ->and($response->json('data.0.role'))->toBe('owner');
});

test('TC-WS-002 workspace context populates from slug header', function () {
    [$user, $token] = loginAs($this->owner);

    $this->getJson('/api/v1/workspace', wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.workspace.slug', 'acme')
        ->assertJsonPath('data.my_role', 'owner');
});

test('TC-WS-003 workspace stats count members', function () {
    [$user, $token] = loginAs($this->owner);

    $response = $this->getJson('/api/v1/workspace', wsHeaders($token, 'acme'));

    expect($response->json('data.stats.member_count'))->toBe(2);
});

test('TC-WS-004 switching workspace changes visible data (slug in header)', function () {
    // tony joins globex too — shared user across workspaces (demo isolation case)
    $this->ws2->members()->attach($this->owner->id, ['role' => 'member']);
    [$user, $token] = loginAs($this->owner);

    $this->getJson('/api/v1/workspace', wsHeaders($token, 'acme'))
        ->assertJsonPath('data.workspace.slug', 'acme');

    $this->getJson('/api/v1/workspace', wsHeaders($token, 'globex'))
        ->assertJsonPath('data.workspace.slug', 'globex')
        ->assertJsonPath('data.my_role', 'member');
});

test('TC-WS-008 missing X-Workspace-Id header → 400 WS_HEADER_REQUIRED', function () {
    [$user, $token] = loginAs($this->owner);

    $this->getJson('/api/v1/workspace', authHeaders($token))
        ->assertStatus(400)
        ->assertJsonPath('error.code', 'WS_HEADER_REQUIRED');
});

test('TC-WS-009 non-member with another workspace → 403 WS_FORBIDDEN', function () {
    [$user, $token] = loginAs($this->member);

    // somchai is not in globex
    $this->getJson('/api/v1/workspace', wsHeaders($token, 'globex'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'WS_FORBIDDEN');
});

test('TC-WS-012 archived workspace → 403 WS_ARCHIVED', function () {
    $this->ws->fresh()->forceFill(['status' => 'archived'])->save();
    [$user, $token] = loginAs($this->owner);

    $this->getJson('/api/v1/workspace', wsHeaders($token, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'WS_ARCHIVED');
});

test('TC-WS-019 member directory lists workspace members', function () {
    [$user, $token] = loginAs($this->owner);

    $response = $this->getJson('/api/v1/members', wsHeaders($token, 'acme'));

    $response->assertOk();
    $usernames = collect($response->json('data'))->pluck('username');
    expect($usernames)->toHaveCount(2)
        ->and($usernames)->toContain('tony', 'somchai');
});

test('TC-WS-020 member directory searches by name and username (citext)', function () {
    [$user, $token] = loginAs($this->owner);

    $response = $this->getJson('/api/v1/members?q=TONY', wsHeaders($token, 'acme'));

    expect(collect($response->json('data'))->pluck('username'))->toContain('tony');
});

test('TC-WS-021 deactivated users are hidden from directory', function () {
    $this->member->fresh()->forceFill(['status' => 'deactivated'])->save();
    [$user, $token] = loginAs($this->owner);

    $response = $this->getJson('/api/v1/members', wsHeaders($token, 'acme'));

    $usernames = collect($response->json('data'))->pluck('username');
    expect($usernames)->not->toContain('somchai')
        ->and($usernames)->toContain('tony');
});

test('TC-WS-022 unknown workspace slug → 404 (no existence leak)', function () {
    [$user, $token] = loginAs($this->owner);

    $this->getJson('/api/v1/workspace', wsHeaders($token, 'nonexistent'))
        ->assertStatus(404);
});

test('TC-READ-013 workspace badges total unread and exclude muted deleted rooms', function () {
    $room = App\Models\Room::create(['workspace_id' => $this->ws->id, 'type' => 'group', 'name' => 'Unread', 'created_by' => $this->owner->id, 'owner_id' => $this->owner->id, 'last_seq' => 6, 'last_user_seq' => 6, 'member_count' => 1]);
    $room->forceFill(['last_seq' => 6, 'last_user_seq' => 6])->save();
    App\Models\RoomMember::create(['room_id' => $room->id, 'workspace_id' => $this->ws->id, 'user_id' => $this->owner->id, 'role' => 'owner', 'last_read_seq' => 0]);
    [$user, $token] = loginAs($this->owner);
    $this->getJson('/api/v1/me/workspaces', authHeaders($token))->assertJsonPath('data.0.unread_rooms_count', 1)->assertJsonPath('data.0.total_unread', 6);
    App\Models\RoomNotificationSetting::create(['room_id' => $room->id, 'user_id' => $user->id, 'mode' => 'all', 'muted_until' => now()->addHour()]);
    $this->getJson('/api/v1/me/workspaces', authHeaders($token))->assertJsonPath('data.0.unread_rooms_count', 0)->assertJsonPath('data.0.total_unread', 0);
    App\Models\RoomNotificationSetting::where('room_id', $room->id)->delete();
    $room->forceFill(['deleted_at' => now()])->save();
    $this->getJson('/api/v1/me/workspaces', authHeaders($token))->assertJsonPath('data.0.unread_rooms_count', 0);
});
