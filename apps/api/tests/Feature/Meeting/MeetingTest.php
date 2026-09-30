<?php

use App\Domain\Calls\MediaServer;
use App\Domain\Calls\MeetingService;
use App\Domain\Media\MediaUrls;
use App\Jobs\ReconcileMeetings;
use App\Models\Meeting;
use App\Models\MeetingParticipant;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Http\Client\Factory;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;

function fakeMeetingMedia($callback): void
{
    Http::swap(new Factory);
    Http::preventStrayRequests();
    Http::fake($callback);
}

beforeEach(function () {
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example']);
    fakeMeetingMedia(fn () => Http::response([], 200));
    $this->host = User::factory()->create(['display_name' => 'Verified host']);
    $this->ws = Workspace::factory()->create(['slug' => 'meetings']);
    $this->ws->members()->attach($this->host->id, ['role' => 'member']);
    [, $token] = loginAs($this->host);
    $this->headers = wsHeaders($token, 'meetings');
});

function meetingFixture($test)
{
    return $test->postJson('/api/v1/meetings', ['title' => 'External review'], $test->headers)->assertCreated()->json('data');
}

test('TC-MEET-001 creator links are workspace scoped and require authentication', function () {
    $this->postJson('/api/v1/meetings', ['title' => 'x'])->assertUnauthorized();
    $m = meetingFixture($this);
    expect(strlen($m['code']))->toBe(64);
    $this->getJson('/api/v1/meetings', $this->headers)->assertJsonCount(1, 'data');
    $other = User::factory()->create();
    $this->ws->members()->attach($other->id, ['role' => 'member']);
    [, $token] = loginAs($other);
    $this->getJson('/api/v1/meetings', wsHeaders($token, 'meetings'))->assertJsonCount(0, 'data');
    $this->postJson('/api/v1/meetings/'.$m['id'].'/end', [], wsHeaders($token, 'meetings'))->assertNotFound();
});

test('TC-MEET-002 public link discloses no workspace or private room data', function () {
    $m = meetingFixture($this);
    $data = $this->getJson('/api/v1/public-meetings/'.$m['code'])->assertOk()->json('data');
    expect($data)->not->toHaveKeys(['workspace_id', 'created_by', 'participants']);
    $this->getJson('/api/v1/public-meetings/'.str_repeat('0', 64))->assertNotFound();
});

test('TC-MEET-003 guest name is required and labeled in scoped media token', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';
    $this->postJson($url, ['name' => '   '])->assertUnprocessable();
    $this->postJson($url, ['name' => str_repeat('a', 81)])->assertUnprocessable();
    $join = $this->postJson($url, ['name' => '  Visitor  '])->assertOk()->json('data');
    $claims = app(MediaServer::class)->decode($join['token']);
    expect($claims->name)->toBe('Visitor (Guest)')->and($claims->video->room)->toBe('meeting-'.$m['id'])->and($claims->video->canPublishData)->toBeFalse();
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$join['token']])->assertNoContent();
    $this->getJson('/api/v1/me', ['Authorization' => 'Bearer '.$join['participant_token']])->assertUnauthorized();
});

test('TC-MEET-004 member identity cannot be spoofed and invalid auth cannot downgrade to guest', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'];
    $this->getJson($url, $this->headers)->assertJsonPath('data.identity.name', 'Verified host');
    $join = $this->postJson($url.'/join', ['name' => 'Imposter'], $this->headers)->assertOk()->json('data');
    expect(app(MediaServer::class)->decode($join['token'])->name)->toBe('Verified host');
    $this->postJson($url.'/join', ['name' => 'Visitor'], ['Authorization' => 'Bearer invalid'])->assertUnauthorized();
});

test('TC-MEET-005 guest rejoin reuses identity and leave invalidates admission', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'];
    $a = $this->postJson($url.'/join', ['name' => 'Visitor'])->json('data');
    $b = $this->postJson($url.'/join', ['participant_token' => $a['participant_token']])->assertOk()->json('data');
    expect(app(MediaServer::class)->decode($a['token'])->sub)->toBe(app(MediaServer::class)->decode($b['token'])->sub);
    $this->postJson($url.'/leave', ['participant_token' => 'bad'])->assertForbidden();
    $this->postJson($url.'/leave', ['participant_token' => $b['participant_token']])->assertNoContent();
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$b['token']])->assertForbidden();
});

test('TC-MEET-006 capacity is bounded and expired absent reservations release slots', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';
    for ($i = 0; $i < 8; $i++) {
        $this->postJson($url, ['name' => 'Guest '.$i])->assertOk();
    }
    $this->postJson($url, ['name' => 'Overflow'])->assertStatus(409);
    DB::table('meeting_participants')->update(['updated_at' => now()->subSeconds(31)]);
    $this->postJson($url, ['name' => 'New arrival'])->assertOk();
});

test('TC-MEET-007 ending and expiry revoke both public link and media admission', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'];
    $a = $this->postJson($url.'/join', ['name' => 'Visitor'])->json('data');
    $this->postJson('/api/v1/meetings/'.$m['id'].'/end', [], $this->headers)->assertNoContent();
    $this->postJson($url.'/join', ['name' => 'Visitor'])->assertStatus(410);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$a['token']])->assertForbidden();
    $m = meetingFixture($this);
    DB::table('meetings')->where('id', $m['id'])->update(['expires_at' => now()->subSecond()]);
    $this->getJson('/api/v1/public-meetings/'.$m['code'])->assertStatus(410);
});

test('TC-MEET-008 removed creator and revoked member sessions invalidate media', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';
    $join = $this->postJson($url, [], $this->headers)->assertOk()->json('data');
    DB::table('sessions')->where('user_id', $this->host->id)->update(['revoked_at' => now()]);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$join['token']])->assertForbidden();
    $this->ws->members()->updateExistingPivot($this->host->id, ['status' => 'removed']);
    $this->postJson($url, ['name' => 'Visitor'])->assertStatus(410);
});

test('TC-MEET-004 accounts from another workspace retain verified identity without chat membership', function () {
    $m = meetingFixture($this);
    $visitor = User::factory()->create(['display_name' => 'External member']);
    [, $token] = loginAs($visitor);
    $join = $this->postJson('/api/v1/public-meetings/'.$m['code'].'/join', ['name' => 'Fake'], ['Authorization' => 'Bearer '.$token])->assertOk()->json('data');
    expect(app(MediaServer::class)->decode($join['token'])->name)->toBe('External member');
    $this->getJson('/api/v1/rooms', wsHeaders($token, 'meetings'))->assertForbidden();
    $visitor->update(['status' => 'suspended']);
    $this->getJson('/api/v1/public-meetings/'.$m['code'], ['Authorization' => 'Bearer '.$token])->assertForbidden();
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$join['token']])->assertForbidden();
});

test('TC-MEET-005 participant secrets cannot cross meetings or upgrade guest identity', function () {
    $a = meetingFixture($this);
    $b = meetingFixture($this);
    $join = $this->postJson('/api/v1/public-meetings/'.$a['code'].'/join', ['name' => 'Visitor'])->json('data');
    $this->postJson('/api/v1/public-meetings/'.$b['code'].'/leave', ['participant_token' => $join['participant_token']])->assertForbidden();
    $this->postJson('/api/v1/public-meetings/'.$a['code'].'/join', ['participant_token' => $join['participant_token']], $this->headers)->assertForbidden();
    $claims = app(MediaServer::class)->decode($join['token']);
    $forged = app(MediaServer::class)->token(['sub' => $claims->sub, 'video' => ['roomJoin' => true, 'room' => 'meeting-'.$b['id']]]);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$forged])->assertForbidden();
});

test('TC-MEET-009 reconciliation evicts revoked members and retries ended room deletion after media outage', function () {
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';
    $join = $this->postJson($url, [], $this->headers)->json('data');
    $pid = $join['participant_id'];
    $remote = 'meeting-'.$m['id'];
    DB::table('sessions')->where('user_id', $this->host->id)->update(['revoked_at' => now()]);
    fakeMeetingMedia(function ($r) use ($remote, $pid) {
        if (str_ends_with($r->url(), 'ListRooms')) {
            return Http::response(['rooms' => [['name' => $remote]]]);
        }
        if (str_ends_with($r->url(), 'ListParticipants')) {
            return Http::response(['participants' => [['identity' => $pid]]]);
        }

        return Http::response([]);
    });
    app()->call([new ReconcileMeetings, 'handle']);
    expect(MeetingParticipant::find($pid)->left_at)->not->toBeNull();
    Http::assertSent(fn ($r) => str_ends_with($r->url(), 'RemoveParticipant') && $r['identity'] === $pid);
    fakeMeetingMedia(fn () => Http::response([], 503));
    try {
        app(MeetingService::class)->end(Meeting::find($m['id']));
    } catch (Throwable) {
    }
    expect(Meeting::find($m['id'])->ended_at)->not->toBeNull();
    fakeMeetingMedia(fn ($r) => Http::response(str_ends_with($r->url(), 'ListRooms') ? ['rooms' => [['name' => $remote]]] : []));
    app()->call([new ReconcileMeetings, 'handle']);
    Http::assertSent(fn ($r) => str_ends_with($r->url(), 'DeleteRoom') && $r['room'] === $remote);
});

test('TC-MEET-008 archived workspace expires guest grants and reconciliation ends media', function () {
    $m = meetingFixture($this);
    $join = $this->postJson('/api/v1/public-meetings/'.$m['code'].'/join', ['name' => 'Visitor'])->json('data');
    $this->ws->update(['status' => 'archived']);
    $this->getJson('/api/v1/calls/authorize-media', ['Authorization' => 'Bearer '.$join['token']])->assertForbidden();
    fakeMeetingMedia(fn ($r) => Http::response(str_ends_with($r->url(), 'ListRooms') ? ['rooms' => [['name' => 'meeting-'.$m['id']]]] : []));
    app()->call([new ReconcileMeetings, 'handle']);
    expect(Meeting::find($m['id'])->ended_at)->not->toBeNull();
});

// FR-CALL-009 / DEC-086: a guest backgrounding their phone rejoins minutes
// later — meeting join tokens share calls.token_ttl and a resume rejoin must
// not mint a duplicate participant.
test('TC-MEET-011 meeting join tokens use calls.token_ttl and resume rejoins reuse the participant', function () {
    config(['calls.token_ttl' => 7200]);
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';
    $join = $this->postJson($url, ['name' => 'Visitor'])->assertOk()->json('data');
    $claims = json_decode(base64_decode(strtr(explode('.', $join['token'])[1], '-_', '+/')), true);
    expect($claims['exp'] - $claims['nbf'])->toBeGreaterThanOrEqual(7200)->toBeLessThan(7210);
    $again = $this->postJson($url, ['participant_token' => $join['participant_token']])->assertOk()->json('data');
    expect(MeetingParticipant::where('meeting_id', $m['id'])->count())->toBe(1);
    $againClaims = json_decode(base64_decode(strtr(explode('.', $again['token'])[1], '-_', '+/')), true);
    expect($againClaims['exp'] - $againClaims['nbf'])->toBeGreaterThanOrEqual(7200);
});

/*
 * FR-PROF-007 / DEC-089 fixtures — unique names (AvatarTest owns
 * avatarGif) so single-file pest runs work too.
 */
function meetingAvatarGif(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagegif($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/** Pin the local disk + signed-route callbacks exactly like AvatarTest. */
function meetingAvatarDisk(): void
{
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));
}

/** Upload → PUT → complete an avatar in the `meetings` workspace; returns the attachment id. */
function meetingUploadAvatar($test, string $token, string $filename, string $mime, string $bytes): string
{
    $created = $test->postJson('/api/v1/uploads', [
        'kind' => 'avatar',
        'filename' => $filename,
        'mime_type' => $mime,
        'size_bytes' => strlen($bytes),
    ], wsHeaders($token, 'meetings'))->assertStatus(201)->json('data');

    $test->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)
        ->assertOk();

    $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'meetings'))
        ->assertOk();

    return $created['attachment_id'];
}

// FR-PROF-007 / DEC-089: meeting join tokens carry the same LiveKit
// `metadata` claim as private calls — a member's avatar object, an explicit
// null for members without one and for public-meeting GUESTS (user_id null),
// with signed urls that outlive the token. No user id, no email — the claim
// must hold nothing but the avatar.
test('TC-MEET-012 meeting join token metadata carries member avatars and null for guests', function () {
    meetingAvatarDisk();
    $m = meetingFixture($this);
    $url = '/api/v1/public-meetings/'.$m['code'].'/join';

    // public-meeting GUEST (user_id null) — explicit null avatar
    $guest = $this->postJson($url, ['name' => 'Visitor'])->assertOk()->json('data');
    expect(json_decode(app(MediaServer::class)->decode($guest['token'])->metadata, true))->toBe(['avatar' => null]);

    // member WITHOUT an avatar — null as well
    $visitor = User::factory()->create();
    [, $visitorToken] = loginAs($visitor);
    $bare = $this->postJson($url, ['name' => 'No Photo'], authHeaders($visitorToken))->assertOk()->json('data');
    expect(json_decode(app(MediaServer::class)->decode($bare['token'])->metadata, true))->toBe(['avatar' => null]);

    // member WITH a gif avatar — object with the animated original, urls outlive the token
    $hostToken = substr($this->headers['Authorization'], 7);
    $gid = meetingUploadAvatar($this, $hostToken, 'host.gif', 'image/gif', meetingAvatarGif());
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $gid], authHeaders($hostToken))->assertOk();
    $join = $this->postJson($url, [], $this->headers)->assertOk()->json('data');
    $claims = app(MediaServer::class)->decode($join['token']);
    $meta = json_decode($claims->metadata, true);
    expect(array_keys($meta))->toBe(['avatar']);
    expect(array_keys($meta['avatar']))->toBe(['sm', 'md', 'animated']);
    expect($meta['avatar']['sm'])->toStartWith('http')
        ->and($meta['avatar']['md'])->toStartWith('http')
        ->and($meta['avatar']['animated'])->toStartWith('http');
    $expiryOf = function (string $url): int {
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);

        return (int) ($q['expires'] ?? 0);
    };
    foreach ($meta['avatar'] as $avatarUrl) {
        expect($expiryOf($avatarUrl))->toBeGreaterThanOrEqual($claims->exp);
    }
});
