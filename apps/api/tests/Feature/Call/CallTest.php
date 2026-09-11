<?php

use App\Domain\Calls\CallService;
use App\Domain\Calls\MediaServer;
use App\Events\CallChanged;
use App\Events\NotificationAlert;
use App\Jobs\ReconcileCalls;
use App\Models\CallParticipant;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    Event::fake([CallChanged::class, NotificationAlert::class]);
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880']);
    $this->mediaDown = false;
    Http::fake(fn () => Http::response([], $this->mediaDown ? 503 : 200));
    $this->caller = User::factory()->create();
    $this->callee = User::factory()->create();
    $this->outsider = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'calls']);
    foreach ([$this->caller, $this->callee, $this->outsider] as $u) {
        $this->ws->members()->attach($u->id, ['role' => 'member']);
    }
    $this->room = Room::create(['workspace_id' => $this->ws->id, 'type' => 'dm', 'created_by' => $this->caller->id, 'member_count' => 2]);
    foreach ([$this->caller, $this->callee] as $u) {
        $this->room->members()->attach($u->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    }
    [, $token] = loginAs($this->caller);
    $this->headers = wsHeaders($token, 'calls');
    [, $token] = loginAs($this->callee);
    $this->calleeHeaders = wsHeaders($token, 'calls');
    [, $token] = loginAs($this->outsider);
    $this->outsiderHeaders = wsHeaders($token, 'calls');
});

test('TC-CALL-001 concurrent repeated starts share the same call and room outsiders cannot discover or join', function () {
    $url = '/api/v1/rooms/'.$this->room->id.'/calls';
    $call = $this->postJson($url, ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');
    $this->postJson($url, ['kind' => 'video'], $this->calleeHeaders)->assertSuccessful()->assertJsonPath('data.id', $call['id']);
    $this->getJson('/api/v1/calls', $this->outsiderHeaders)->assertOk()->assertJsonCount(0, 'data.calls');
    $this->postJson('/api/v1/calls/'.$call['id'].'/join', [], $this->outsiderHeaders)->assertNotFound();
});

test('TC-CALL-002 voice grant cannot publish camera and groups reject voice-only calls', function () {
    $call = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'voice'], $this->headers)->assertSuccessful()->json('data');
    $token = $this->postJson('/api/v1/calls/'.$call['id'].'/join', [], $this->headers)->assertOk()->json('data.token');
    $claims = json_decode(base64_decode(strtr(explode('.', $token)[1], '-_', '+/')), true);
    expect($claims['video']['canPublishSources'])->toBe(['microphone']);
    expect($claims['video']['room'])->toBe('call-'.$call['id']);
    $this->room->update(['type' => 'group']);
    $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'voice'], $this->headers)->assertUnprocessable();
});

test('TC-CALL-005 signaling admission rejects removed members and tokens from ended calls', function () {
    $call = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $token = $this->postJson('/api/v1/calls/'.$call['id'].'/join', [], $this->calleeHeaders)->assertOk()->json('data.token');
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$token])->assertNoContent();
    $this->room->members()->updateExistingPivot($this->callee->id, ['left_at' => now()]);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$token])->assertForbidden();
});

test('TC-CALL-003 decline ends unanswered dm and only starter may end a group', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/end', [], $this->calleeHeaders)->assertForbidden();
    $this->postJson('/api/v1/calls/'.$c['id'].'/decline', [], $this->calleeHeaders)->assertNoContent();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertStatus(409);
    $this->getJson('/api/v1/calls', $this->headers)->assertJsonCount(0, 'data.calls');
});

test('TC-CALL-004 group leave preserves other members and last leave ends call', function () {
    $this->room->update(['type' => 'group']);
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/leave', [], $this->headers)->assertNoContent();
    $this->getJson('/api/v1/calls', $this->calleeHeaders)->assertJsonCount(1, 'data.calls');
    $this->postJson('/api/v1/calls/'.$c['id'].'/leave', [], $this->calleeHeaders)->assertNoContent();
    $this->getJson('/api/v1/calls', $this->calleeHeaders)->assertJsonCount(0, 'data.calls');
});

test('TC-CALL-006 revoked login and ended calls fail signaling even with valid signed tokens', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $token = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->json('data.token');
    DB::table('sessions')->where('user_id', $this->callee->id)->update(['revoked_at' => now()]);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$token])->assertForbidden();
    $token = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->json('data.token');
    $this->postJson('/api/v1/calls/'.$c['id'].'/end', [], $this->headers)->assertNoContent();
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$token])->assertForbidden();
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer forged'])->assertUnauthorized();
});

test('TC-CALL-007 media outage must not roll back leave revocation', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $token = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->json('data.token');
    $this->mediaDown = true;
    $this->postJson('/api/v1/calls/'.$c['id'].'/leave', [], $this->headers)->assertStatus(503);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$token])->assertForbidden();
});

test('TC-CALL-001 workspace header cannot access another workspace call', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $other = Workspace::factory()->create(['slug' => 'other-call']);
    $other->members()->attach($this->caller->id, ['role' => 'member']);
    $headers = array_merge($this->headers, ['X-Workspace-Id' => 'other-call']);
    $this->getJson('/api/v1/calls', $headers)->assertJsonCount(0, 'data.calls');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $headers)->assertNotFound();
});

test('TC-CALL-007 reconciler evicts revoked participants without browser cooperation', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $participant = CallParticipant::where('call_id', $c['id'])->first();
    DB::table('sessions')->where('user_id', $this->callee->id)->update(['revoked_at' => now()]);
    $media = Mockery::mock(MediaServer::class);
    $media->shouldReceive('request')->with('ListRooms', '', [])->andReturn(['rooms' => [['name' => 'call-'.$c['id']]]]);
    $media->shouldReceive('request')->with('ListParticipants', 'call-'.$c['id'], ['room' => 'call-'.$c['id']])->andReturn(['participants' => [['identity' => $participant->id]]]);
    $media->shouldReceive('request')->with('RemoveParticipant', 'call-'.$c['id'], ['room' => 'call-'.$c['id'], 'identity' => $participant->id])->once()->andReturn([]);
    (new ReconcileCalls)->handle(app(CallService::class), $media);
    expect($participant->fresh()->left_at)->not->toBeNull();
});

test('TC-CALL-003 call sound respects muted user preference', function () {
    UserNotificationSetting::create(['user_id' => $this->callee->id, 'sound' => false]);
    $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertOk();
    Event::assertNotDispatched(NotificationAlert::class);
});

test('TC-CALL-007 Twirp deletion uses roomCreate grant and empty requests serialize as objects', function () {
    $media = app(MediaServer::class);
    $media->request('DeleteRoom', 'call-test', ['room' => 'call-test']);
    Http::assertSent(function ($request) {
        if (! str_ends_with($request->url(), '/DeleteRoom')) {
            return false;
        }
        $token = substr($request->header('Authorization')[0], 7);
        $claims = json_decode(base64_decode(strtr(explode('.', $token)[1], '-_', '+/')), true);

        return ($claims['video']['roomCreate'] ?? false) === true;
    });
    $media->request('ListRooms', '');
    Http::assertSent(fn ($request) => str_ends_with($request->url(), '/ListRooms') && $request->body() === '{}');
});

test('TC-CALL-002 capacity is enforced before issuing a third participant token', function () {
    config(['calls.max_participants' => 2]);
    $this->room->update(['type' => 'group']);
    $this->room->members()->attach($this->outsider->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->outsiderHeaders)->assertStatus(409);
});

test('TC-CALL-009 logout ends dm even before first connected-state reconciliation', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $caller = CallParticipant::where('call_id', $c['id'])->where('user_id', $this->caller->id)->first();
    $callee = CallParticipant::where('call_id', $c['id'])->where('user_id', $this->callee->id)->first();
    DB::table('sessions')->where('user_id', $this->caller->id)->update(['revoked_at' => now()]);
    $media = Mockery::mock(MediaServer::class);
    $media->shouldReceive('request')->with('ListRooms', '', [])->andReturn(['rooms' => [['name' => 'call-'.$c['id']]]]);
    $media->shouldReceive('request')->with('ListParticipants', 'call-'.$c['id'], ['room' => 'call-'.$c['id']])->andReturn(['participants' => [['identity' => $callee->id, 'state' => 'ACTIVE']]]);
    (new ReconcileCalls)->handle(app(CallService::class), $media);
    expect(RoomCall::find($c['id'])->ended_at)->not->toBeNull();
});

test('TC-CALL-004 removing the group starter preserves remaining participants', function () {
    $this->room->update(['type' => 'group']);
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk();
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $starter = CallParticipant::where('call_id', $c['id'])->where('user_id', $this->caller->id)->first();
    $remaining = CallParticipant::where('call_id', $c['id'])->where('user_id', $this->callee->id)->first();
    $this->room->members()->updateExistingPivot($this->caller->id, ['left_at' => now()]);
    $media = Mockery::mock(MediaServer::class);
    $media->shouldReceive('request')->with('ListRooms', '', [])->andReturn(['rooms' => [['name' => 'call-'.$c['id']]]]);
    $media->shouldReceive('request')->with('ListParticipants', 'call-'.$c['id'], ['room' => 'call-'.$c['id']])->andReturn(['participants' => [['identity' => $starter->id, 'state' => 'ACTIVE'], ['identity' => $remaining->id, 'state' => 'ACTIVE']]]);
    $media->shouldReceive('request')->with('RemoveParticipant', 'call-'.$c['id'], ['room' => 'call-'.$c['id'], 'identity' => $starter->id])->once()->andReturn([]);
    (new ReconcileCalls)->handle(app(CallService::class), $media);
    expect(RoomCall::find($c['id'])->ended_at)->toBeNull();
    expect($starter->fresh()->left_at)->not->toBeNull();
    expect($remaining->fresh()->left_at)->toBeNull();
});
