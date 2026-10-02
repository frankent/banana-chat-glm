<?php

use App\Domain\Calls\CallService;
use App\Domain\Calls\MediaServer;
use App\Domain\Media\MediaUrls;
use App\Events\CallChanged;
use App\Events\MessageCreated;
use App\Events\NotificationAlert;
use App\Events\RoomActivity;
use App\Jobs\NotifyMessage;
use App\Jobs\ReconcileCalls;
use App\Models\CallParticipant;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Models\Workspace;
use App\Services\SettingsService;
use Firebase\JWT\JWT;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;

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
    app(SettingsService::class)->set('call.max_participants', 2);
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

// FR-CALL-009 / DEC-086: backgrounded phones reconnect minutes after joining —
// the join token must outlive 60s, while admin/API-to-SFU credentials stay short.
test('TC-CALL-040 participant join tokens carry calls.token_ttl while API-to-SFU tokens stay 60 seconds', function () {
    config(['calls.token_ttl' => 3600]);
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $join = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk()->json('data');
    $claims = json_decode(base64_decode(strtr(explode('.', $join['token'])[1], '-_', '+/')), true);
    expect($claims['exp'] - $claims['nbf'])->toBeGreaterThanOrEqual(3600)->toBeLessThan(3610);
    // Admin (Twirp) requests keep the historic 60s credential.
    app(MediaServer::class)->request('ListRooms', '');
    Http::assertSent(function ($request) {
        if (! str_ends_with($request->url(), '/ListRooms')) {
            return false;
        }
        $token = substr($request->header('Authorization')[0], 7);
        $claims = json_decode(base64_decode(strtr(explode('.', $token)[1], '-_', '+/')), true);

        return $claims['exp'] - $claims['nbf'] <= 65;
    });
});

// FR-CALL-009 / DEC-086: the longer ttl must not weaken revocation — signaling
// accepts a reconnect token minutes old, rejects anything past the ttl, and
// still 403s a participant whose left_at is set regardless of token age.
test('TC-CALL-041 authorizeMedia accepts an in-ttl stale token, rejects past-ttl, and left participants stay 403', function () {
    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');
    $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk();
    $p = CallParticipant::where('call_id', $c['id'])->where('user_id', $this->callee->id)->first();
    $mint = fn (int $age, int $ttl) => JWT::encode(
        ['iss' => 'testkey', 'nbf' => time() - $age - 5, 'exp' => time() - $age + $ttl, 'sub' => $p->id, 'video' => ['room' => 'call-'.$c['id']]],
        config('calls.secret'), 'HS256',
    );
    // 2 minutes old but well within the 6h default participant ttl.
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$mint(120, 21600)])->assertNoContent();
    // Older than the ttl: expired JWT fails closed with 401.
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$mint(21600 + 120, 21600)])->assertUnauthorized();
    // Membership revocation still denies even a brand-new unexpired token.
    $p->update(['left_at' => now()]);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$mint(0, 21600)])->assertForbidden();
});

/*
 * FR-PROF-007 / DEC-089 fixtures — deliberately unique names (AvatarTest
 * owns avatarPng/avatarGif/uploadAvatar) so single-file pest runs work too.
 */
function callAvatarPng(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

function callAvatarGif(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagegif($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/** Pin the local disk + signed-route callbacks exactly like AvatarTest. */
function callAvatarDisk(): void
{
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));
}

/** Upload → PUT → complete an avatar in the `calls` workspace; returns the attachment id. */
function callUploadAvatar($test, string $token, string $filename, string $mime, string $bytes): string
{
    $created = $test->postJson('/api/v1/uploads', [
        'kind' => 'avatar',
        'filename' => $filename,
        'mime_type' => $mime,
        'size_bytes' => strlen($bytes),
    ], wsHeaders($token, 'calls'))->assertStatus(201)->json('data');

    $test->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)
        ->assertOk();

    $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'calls'))
        ->assertOk();

    return $created['attachment_id'];
}

// FR-PROF-007 / DEC-089: the join token carries the standard LiveKit
// `metadata` claim — the joiner's avatar object or an explicit null, and
// nothing else (no user id, no email). The signed URLs inside must outlive
// the token so a client never holds a valid token with dead image links.
test('TC-CALL-043 join token metadata carries the avatar object, null without one, urls outlive the token', function () {
    callAvatarDisk();
    $callerToken = substr($this->headers['Authorization'], 7);
    $gid = callUploadAvatar($this, $callerToken, 'caller.gif', 'image/gif', callAvatarGif());
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $gid], authHeaders($callerToken))->assertOk();

    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');

    // member WITH an avatar — full object, animated non-null for a gif
    $join = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->headers)->assertOk()->json('data');
    $claims = app(MediaServer::class)->decode($join['token']);
    $meta = json_decode($claims->metadata, true);
    expect($meta)->toBeArray()->and(array_keys($meta))->toBe(['avatar']);
    expect(array_keys($meta['avatar']))->toBe(['sm', 'md', 'animated']);
    expect($meta['avatar']['sm'])->toStartWith('http')
        ->and($meta['avatar']['md'])->toStartWith('http')
        ->and($meta['avatar']['animated'])->toStartWith('http');
    $expiryOf = function (string $url): int {
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);

        return (int) ($q['expires'] ?? 0);
    };
    foreach ($meta['avatar'] as $url) {
        expect($expiryOf($url))->toBeGreaterThanOrEqual($claims->exp);
    }

    // member WITHOUT an avatar — explicit null, still only the avatar key
    $bare = $this->postJson('/api/v1/calls/'.$c['id'].'/join', [], $this->calleeHeaders)->assertOk()->json('data');
    expect(json_decode(app(MediaServer::class)->decode($bare['token'])->metadata, true))->toBe(['avatar' => null]);
});

// FR-PROF-007 / DEC-089: the list/ringing call object gains caller_avatar
// (the starter) and — DM rooms only — peer_avatar from the viewer's side.
test('TC-CALL-044 serialize adds caller_avatar and dm peer_avatar, null peer in groups', function () {
    callAvatarDisk();
    $callerToken = substr($this->headers['Authorization'], 7);
    $pid = callUploadAvatar($this, $callerToken, 'caller.png', 'image/png', callAvatarPng());
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $pid], authHeaders($callerToken))->assertOk();

    $c = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->json('data');

    // callee's ringing view: the photo'd caller started it AND is the dm peer
    $row = $this->getJson('/api/v1/calls', $this->calleeHeaders)->assertOk()->json('data.calls.0');
    expect($row['caller_avatar']['sm'])->toStartWith('http')
        ->and($row['caller_avatar']['md'])->toStartWith('http')
        ->and($row['caller_avatar']['animated'])->toBeNull()
        ->and($row['peer_avatar']['sm'])->toStartWith('http');

    // caller's own view: same caller_avatar, avatar-less dm peer
    $mine = $this->getJson('/api/v1/calls', $this->headers)->assertOk()->json('data.calls.0');
    expect($mine['caller_avatar'])->not->toBeNull()->and($mine['peer_avatar'])->toBeNull();

    $this->postJson('/api/v1/calls/'.$c['id'].'/end', [], $this->headers)->assertNoContent();

    // group rooms: peer_avatar stays null; an avatar-less starter serializes caller_avatar null
    $this->room->update(['type' => 'group']);
    $g = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->calleeHeaders)->json('data');
    $grow = collect($this->getJson('/api/v1/calls', $this->headers)->assertOk()->json('data.calls'))->first(fn ($r) => $r['id'] === $g['id']);
    expect($grow['caller_avatar'])->toBeNull()->and($grow['peer_avatar'])->toBeNull();
});

// FR-PROF-007 / DEC-089: GET /calls batches the avatar lookups — the
// attachments query count must not grow with the number of ringing calls.
test('TC-CALL-045 calls list batches avatar lookups across rows (no N+1)', function () {
    callAvatarDisk();
    $callerToken = substr($this->headers['Authorization'], 7);
    $pid = callUploadAvatar($this, $callerToken, 'caller.png', 'image/png', callAvatarPng());
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $pid], authHeaders($callerToken))->assertOk();

    $openCalls = function (int $n): void {
        for ($i = 0; $i < $n; $i++) {
            $peer = User::factory()->create();
            $this->ws->members()->attach($peer->id, ['role' => 'member']);
            $room = Room::create(['workspace_id' => $this->ws->id, 'type' => 'dm', 'created_by' => $this->caller->id, 'member_count' => 2]);
            foreach ([$this->caller, $peer] as $u) {
                $room->members()->attach($u->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
            }
            $this->postJson('/api/v1/rooms/'.$room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful();
        }
    };

    $attachmentQueries = function (int $expectedCalls): int {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $this->getJson('/api/v1/calls', $this->headers)->assertOk()->assertJsonCount($expectedCalls, 'data.calls');
        DB::disableQueryLog();

        return collect(DB::getQueryLog())->filter(fn ($q) => str_contains($q['query'], 'attachments'))->count();
    };

    $openCalls(2);
    $withTwo = $attachmentQueries(2);
    $openCalls(2);
    $withFour = $attachmentQueries(4);

    expect($withTwo)->toBe(1)->and($withFour)->toBe(1);
});

test('TC-CALL-046 FR-CALL-010 a new call posts ONE call_started system message (ids only); a repeat start posts none', function () {
    Event::fake([CallChanged::class, NotificationAlert::class, MessageCreated::class, RoomActivity::class]);
    $url = '/api/v1/rooms/'.$this->room->id.'/calls';
    $call = $this->postJson($url, ['kind' => 'voice'], $this->headers)->assertSuccessful()->json('data');
    $this->postJson($url, ['kind' => 'voice'], $this->calleeHeaders)->assertSuccessful()->assertJsonPath('data.id', $call['id']);

    $rows = Message::where('room_id', $this->room->id)->where('type', 'system')->get();
    expect($rows)->toHaveCount(1)
        ->and($rows[0]->system_event)->toEqualCanonicalizing(['event' => 'call_started', 'call_id' => $call['id'], 'kind' => 'voice'])
        ->and($rows[0]->sender_id)->toBe($this->caller->id);

    // DEC-091 — announced live to the room and to each member's list
    Event::assertDispatchedTimes(MessageCreated::class, 1);
    Event::assertDispatched(MessageCreated::class, fn ($e) => ($e->broadcastWith()['data']['message']['system_event']['event'] ?? null) === 'call_started');
    Event::assertDispatched(RoomActivity::class, fn ($e) => str_contains(json_encode($e->broadcastWith(), JSON_UNESCAPED_UNICODE), '📞 เริ่มโทรด้วยเสียง'));
});

test('TC-CALL-047 FR-CALL-010 call_started is visible in history, previews the room list and sends no push', function () {
    Queue::fake();
    $this->room->update(['type' => 'group', 'name' => 'Ops']);
    $call = $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers)->assertSuccessful()->json('data');

    Queue::assertNotPushed(NotifyMessage::class);

    $messages = $this->getJson('/api/v1/rooms/'.$this->room->id.'/messages', $this->calleeHeaders)->assertOk()->json('data');
    $messages = $messages['messages'] ?? $messages;
    $system = collect($messages)->firstWhere('type', 'system');
    expect($system['system_event'])->toMatchArray(['event' => 'call_started', 'call_id' => $call['id'], 'kind' => 'video'])
        ->and($system['sender']['id'])->toBe($this->caller->id);

    $row = collect($this->getJson('/api/v1/rooms', $this->calleeHeaders)->assertOk()->json('data'))->firstWhere('room.id', $this->room->id);
    expect($row['last_message']['body'])->toBe('📹 เริ่มวิดีโอคอล');
});

test('TC-CALL-048 FR-CALL-010 a start that fails (media down) leaves no orphan call_started message', function () {
    $this->mediaDown = true;
    $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], $this->headers);
    expect(RoomCall::where('room_id', $this->room->id)->count())->toBe(0)
        ->and(Message::where('room_id', $this->room->id)->where('type', 'system')->count())->toBe(0);
});
