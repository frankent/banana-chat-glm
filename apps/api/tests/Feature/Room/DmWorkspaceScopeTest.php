<?php

use App\Models\Room;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Schema;

beforeEach(function () {
    $this->ann = User::factory()->create(['username' => 'ann']);
    $this->bob = User::factory()->create(['username' => 'bob']);
    $this->w1 = Workspace::factory()->create(['slug' => 'w-one']);
    $this->w2 = Workspace::factory()->create(['slug' => 'w-two']);
    foreach ([$this->w1, $this->w2] as $ws) {
        $ws->members()->attach($this->ann->id, ['role' => 'member']);
        $ws->members()->attach($this->bob->id, ['role' => 'member']);
    }
});

test('TC-ROOM-102 same pair in two workspaces → two different DMs, each deduped', function () {
    [, $token] = loginAs($this->ann);
    $body = ['type' => 'dm', 'user_id' => $this->bob->id];

    $a = $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-one'))->assertStatus(201);
    $b = $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-two'))->assertStatus(201);

    expect($a->json('data.room.id'))->not->toBe($b->json('data.room.id'));

    $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-one'))
        ->assertStatus(200)->assertJsonPath('data.room.id', $a->json('data.room.id'));
    $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-two'))
        ->assertStatus(200)->assertJsonPath('data.room.id', $b->json('data.room.id'));

    expect(Room::withoutGlobalScopes()->whereNotNull('dm_key')->distinct()->count('dm_key'))->toBe(1)
        ->and(Room::withoutGlobalScopes()->whereNotNull('dm_key')->count())->toBe(2);
});

test('TC-ROOM-103 race recovery returns the existing room inside one workspace', function () {
    [, $token] = loginAs($this->ann);
    $body = ['type' => 'dm', 'user_id' => $this->bob->id];

    $first = $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-one'))->assertStatus(201);

    // blind the pre-check once so the insert hits the unique index and the
    // UniqueConstraintViolationException recovery path runs
    $calls = 0;
    Room::addGlobalScope('blind-first', function ($q) use (&$calls) {
        if ($calls++ === 0) {
            $q->whereRaw('1 = 0');
        }
    });

    $second = $this->postJson('/api/v1/rooms', $body, wsHeaders($token, 'w-one'));
    $second->assertStatus(200)->assertJsonPath('data.room.id', $first->json('data.room.id'));
    expect($calls)->toBeGreaterThan(1);
    expect(Room::withoutGlobalScopes()->whereNotNull('dm_key')->count())->toBe(1);
});

test('TC-ROOM-104 index swap is safe on a DB with one DM per pair', function () {
    [, $token] = loginAs($this->ann);
    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->bob->id], wsHeaders($token, 'w-one'))->assertStatus(201);

    $migration = require base_path('database/migrations/2026_10_10_000002_scope_dm_key_unique_to_workspace.php');
    $indexes = fn () => collect(Schema::getIndexes('rooms'))->pluck('name');

    $migration->down();
    expect($indexes())->toContain('rooms_dm_key_unique')->not->toContain('rooms_workspace_dm_key_unique');

    $migration->up();
    expect($indexes())->toContain('rooms_workspace_dm_key_unique')->not->toContain('rooms_dm_key_unique')
        ->and(Room::withoutGlobalScopes()->whereNotNull('dm_key')->count())->toBe(1);
});
