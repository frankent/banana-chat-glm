<?php

use App\Domain\Calls\CallCapacity;
use App\Events\CallChanged;
use App\Events\NotificationAlert;
use App\Filament\Pages\Settings;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Livewire\Livewire;

/**
 * FR-CALL-006 / DEC-057 — admin-adjustable capacity (2–50, default 8) applied as a
 * creation-time snapshot. LiveKit CreateRoom does NOT update max_participants of an
 * existing room, so active calls and existing meeting links keep the capacity they
 * were created with; the setting only shapes NEW calls/links. Direct rooms stay at 2.
 */
beforeEach(function () {
    Event::fake([CallChanged::class, NotificationAlert::class]);
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880']);
    Http::fake(fn () => Http::response([], 200));
    $this->caller = User::factory()->create();
    $this->callee = User::factory()->create();
    $this->outsider = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'capacities']);
    foreach ([$this->caller, $this->callee, $this->outsider] as $u) {
        $this->ws->members()->attach($u->id, ['role' => 'member']);
    }
    $this->room = Room::create(['workspace_id' => $this->ws->id, 'type' => 'dm', 'created_by' => $this->caller->id, 'member_count' => 2]);
    foreach ([$this->caller, $this->callee] as $u) {
        $this->room->members()->attach($u->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    }
    [, $token] = loginAs($this->caller);
    $this->headers = wsHeaders($token, 'capacities');
    [, $token] = loginAs($this->callee);
    $this->calleeHeaders = wsHeaders($token, 'capacities');
    [, $token] = loginAs($this->outsider);
    $this->outsiderHeaders = wsHeaders($token, 'capacities');
});

function createRoomMaxAsserted(int $max): void
{
    Http::assertSent(function ($request) use ($max) {
        if (! str_ends_with($request->url(), '/twirp/livekit.RoomService/CreateRoom')) {
            return false;
        }

        return (json_decode($request->body(), true) ?? [])['max_participants'] === $max;
    });
}

test('TC-CALL-020 runtime setting bounds new group calls in admission and SFU CreateRoom', function () {
    app(SettingsService::class)->set('call.max_participants', 2);
    $this->room->update(['type' => 'group']);
    $this->room->members()->attach($this->outsider->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);

    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');
    expect(RoomCall::find($c['id'])->capacity)->toBe(2);
    createRoomMaxAsserted(2);

    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->outsiderHeaders)->assertStatus(409);
});

test('TC-CALL-021 direct rooms keep the fixed capacity of 2 regardless of the setting', function () {
    app(SettingsService::class)->set('call.max_participants', 50);
    // A third room member is impossible for a real dm; attach one at the pivot level
    // to prove admission itself is capped at 2, not by dm membership size.
    $this->room->members()->attach($this->outsider->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);

    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');
    expect(RoomCall::find($c['id'])->capacity)->toBe(2);
    createRoomMaxAsserted(2);

    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->outsiderHeaders)->assertStatus(409);
});

test('TC-CALL-022 changing the setting never reshapes an active call, only new ones', function () {
    app(SettingsService::class)->set('call.max_participants', 2);
    $this->room->update(['type' => 'group']);
    $this->room->members()->attach($this->outsider->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();

    // Admin raises the cap mid-call: the snapshot wins — no reshape, no disconnects.
    app(SettingsService::class)->set('call.max_participants', 5);
    expect(RoomCall::find($c['id'])->capacity)->toBe(2);
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->outsiderHeaders)->assertStatus(409);
    Http::assertNotSent(fn ($request) => str_ends_with($request->url(), '/twirp/livekit.RoomService/CreateRoom')
        && (json_decode($request->body(), true) ?? [])['max_participants'] !== 2);

    // The next call in the same room picks up the new value end to end.
    $this->postJson('/api/v1/calls/'.$c['id'].'/end', [], $this->headers)->assertNoContent();
    $c2 = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');
    expect(RoomCall::find($c2['id'])->capacity)->toBe(5);
    createRoomMaxAsserted(5);
    $this->postJson('/api/v1/calls/'.$c2['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c2['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $this->postJson('/api/v1/calls/'.$c2['id'].'/join', [], $this->outsiderHeaders)->assertOk();
});

test('TC-CALL-023 meeting links snapshot capacity at creation and lobby reports the snapshot', function () {
    app(SettingsService::class)->set('call.max_participants', 2);
    $m = $this->postJson('/api/v1/meetings', ['title' => 'Snapshot review'], $this->headers)->assertCreated()->json('data');
    $join = '/api/v1/public-meetings/'.$m['code'].'/join';
    $this->postJson($join, ['name' => 'Guest one'])->assertOk();
    $this->postJson($join, ['name' => 'Guest two'])->assertOk();
    $this->postJson($join, ['name' => 'Guest three'])->assertStatus(409);
    $this->getJson('/api/v1/public-meetings/'.$m['code'])->assertOk()->assertJsonPath('data.capacity', 2);

    // Raising the setting after the link exists does not widen (or narrow) it.
    app(SettingsService::class)->set('call.max_participants', 8);
    $this->postJson($join, ['name' => 'Guest three'])->assertStatus(409);
    $this->getJson('/api/v1/public-meetings/'.$m['code'])->assertOk()->assertJsonPath('data.capacity', 2);
    Http::assertNotSent(fn ($request) => str_ends_with($request->url(), '/twirp/livekit.RoomService/CreateRoom')
        && str_contains($request->body(), 'meeting-'.$m['id'])
        && (json_decode($request->body(), true) ?? [])['max_participants'] !== 2);

    // A fresh link created after the change snapshots the new value.
    $m2 = $this->postJson('/api/v1/meetings', ['title' => 'Wider review'], $this->headers)->assertCreated()->json('data');
    $this->getJson('/api/v1/public-meetings/'.$m2['code'])->assertOk()->assertJsonPath('data.capacity', 8);
    $this->postJson('/api/v1/public-meetings/'.$m2['code'].'/join', ['name' => 'Guest one'])->assertOk();
    Http::assertSent(fn ($request) => str_ends_with($request->url(), '/twirp/livekit.RoomService/CreateRoom')
        && (json_decode($request->body(), true) ?? [])['name'] === 'meeting-'.$m2['id']
        && (json_decode($request->body(), true) ?? [])['max_participants'] === 8);
});

test('TC-CALL-024 admin settings expose the capacity key with range, policy note and clamp', function () {
    expect(SettingsService::DEFAULTS['call.max_participants'])->toBe(8)
        ->and(Settings::ranges()['call.max_participants'])->toBe([2, 50])
        ->and(Settings::HELPERS['call.max_participants'])->toContain('NEW group calls')
        ->and(Settings::HELPERS['call.max_participants'])->toContain('keep the capacity they were created with');

    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');
    Livewire::test(Settings::class)->assertFormFieldExists('call.max_participants');

    // Defensive clamp for values that bypass Filament validation.
    $settings = app(SettingsService::class);
    $settings->set('call.max_participants', 1);
    expect(app(CallCapacity::class)->group())->toBe(2);
    $settings->set('call.max_participants', 99);
    expect(app(CallCapacity::class)->group())->toBe(50);
});
