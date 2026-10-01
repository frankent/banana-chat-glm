<?php

use App\Domain\Media\MediaUrls;
use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Enums\RoomRole;
use App\Events\RoomUpdated;
use App\Jobs\NotifyMessage;
use App\Models\Device;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * TC-ROOM-083..093 — group photo (FR-PROF-008, DEC-090, API-022 amended,
 * EVT-002, DEC-087/088): owner/admin sets/replaces/removes, plain members
 * 403 regardless of who_can_edit_info, own-ready-avatar validation, payload
 * serialization with no N+1, URL-free broadcast, no avatar in push.
 *
 * Local disk (pinned in phpunit.xml): signed urls point at the signed API
 * routes the same way AvatarTest exercises them. Helper names are unique —
 * AvatarTest.php owns uploadAvatar()/avatarPng()/avatarGif().
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    $this->tony = User::factory()->create(['username' => 'tony', 'display_name' => 'Tony Stark']);
    $this->somchai = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai Jaidee']);
    $this->anna = User::factory()->create(['username' => 'anna', 'display_name' => 'Anna P']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);
    $this->ws->members()->attach($this->anna->id, ['role' => 'admin']);

    // tony = room owner, somchai = plain member, anna = room admin
    $this->room = makeAvatarGroup($this->ws, $this->tony, [
        ['user' => $this->somchai, 'role' => RoomRole::Member],
        ['user' => $this->anna, 'role' => RoomRole::Admin],
    ]);

    $this->png = roomAvatarPng();
});

/**
 * Minimal GD fixtures (unique names — AvatarTest owns avatarPng()/avatarGif()).
 */
function roomAvatarPng(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

function roomAvatarGif(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagegif($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/**
 * Throwaway RSA key for the FCM service-account assertion (unique name —
 * AvatarTest owns avatarServiceAccountKey()).
 */
function roomAvatarServiceAccountKey(): string
{
    static $pem = null;
    if ($pem === null) {
        $res = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($res, $pem);
    }

    return $pem;
}

/**
 * Upload → PUT → complete as $user, returning the ready attachment id.
 */
function uploadRoomAvatar($test, string $token, string $filename, string $mime, string $bytes): string
{
    $created = $test->postJson('/api/v1/uploads', [
        'kind' => 'avatar',
        'filename' => $filename,
        'mime_type' => $mime,
        'size_bytes' => strlen($bytes),
    ], wsHeaders($token, 'acme'))
        ->assertStatus(201)
        ->json('data');

    $test->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)
        ->assertOk();

    return $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.attachment.id');
}

/**
 * Direct-model group room fixture with per-member roles.
 */
function makeAvatarGroup(Workspace $ws, User $owner, array $others = []): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $owner->id,
        'owner_id' => $owner->id,
        'member_count' => count($others) + 1,
        'last_message_at' => now(),
    ]);

    RoomMember::query()->create([
        'room_id' => $room->id,
        'user_id' => $owner->id,
        'workspace_id' => $ws->id,
        'role' => RoomRole::Owner,
        'added_by' => $owner->id,
    ]);

    foreach ($others as ['user' => $user, 'role' => $role]) {
        RoomMember::query()->create([
            'room_id' => $room->id,
            'user_id' => $user->id,
            'workspace_id' => $ws->id,
            'role' => $role,
            'added_by' => $owner->id,
        ]);
    }

    return $room;
}

// ---- who may change it ----

test('TC-ROOM-083 owner sets the group photo → 200, avatar signed, system message, URL-free room.updated', function () {
    Event::fake([RoomUpdated::class]);
    [$user, $token] = loginAs($this->tony);

    $id = uploadRoomAvatar($this, $token, 'group.png', 'image/png', $this->png);

    $room = $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.avatar_attachment_id', $id)
        ->json('data.room');

    expect($room['avatar'])->not->toBeNull()
        ->and($room['avatar']['sm'])->toStartWith('http')
        ->and($room['avatar']['md'])->toStartWith('http')
        ->and($room['avatar']['sm'])->not->toBe($room['avatar']['md'])
        ->and($room['avatar']['animated'])->toBeNull()
        ->and($this->room->fresh()->avatar_attachment_id)->toBe($id);

    // the sm thumb actually serves the webp bytes
    $this->get($room['avatar']['sm'])->assertOk()->assertHeader('Content-Type', 'image/webp');

    // system message carries the event and NOTHING else — no URLs ever
    $system = Message::query()->where('room_id', $this->room->id)->where('type', 'system')->firstOrFail();
    expect($system->system_event)->toBe(['event' => 'room_avatar_changed'])
        ->and($system->sender_id)->toBe($this->tony->id);

    // EVT-002 room.updated went out, URL-free: the id only, clients refetch
    Event::assertDispatchedTimes(RoomUpdated::class, 1);
    Event::assertDispatched(RoomUpdated::class, function (RoomUpdated $e) use ($id) {
        $payload = $e->broadcastWith();
        $json = json_encode($payload);

        return $payload['data']['room']['avatar_attachment_id'] === $id
            && ! str_contains($json, 'http')
            && ! str_contains($json, '/att/');
    });
});

test('TC-ROOM-084 room admin sets it too; rename + photo in one PATCH write both system messages', function () {
    [$anna, $annaToken] = loginAs($this->anna);
    [$tony, $tonyToken] = loginAs($this->tony);

    $id = uploadRoomAvatar($this, $annaToken, 'anna.png', 'image/png', $this->png);

    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($annaToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.avatar_attachment_id', $id)
        ->assertJsonPath('data.room.avatar.sm', fn ($sm) => str_starts_with((string) $sm, 'http'));

    // owner renaming + replacing in a single PATCH → room_renamed then room_avatar_changed
    $id2 = uploadRoomAvatar($this, $tonyToken, 'group2.png', 'image/png', $this->png);

    $this->patchJson("/api/v1/rooms/{$this->room->id}", [
        'name' => 'Platform',
        'avatar_attachment_id' => $id2,
    ], wsHeaders($tonyToken, 'acme'))->assertOk();

    $events = Message::query()->where('room_id', $this->room->id)->where('type', 'system')
        ->orderBy('seq')->pluck('system_event', 'seq');

    // (jsonb does not preserve key order — compare per key, not whole-array)
    expect($events->values()->get(0)['event'])->toBe('room_avatar_changed')
        ->and($events->values()->get(1)['event'])->toBe('room_renamed')
        ->and($events->values()->get(1)['name'])->toBe('Platform')
        ->and($events->values()->get(2)['event'])->toBe('room_avatar_changed');
});

test('TC-ROOM-085 plain member → 403 ROOM_FORBIDDEN even with who_can_edit_info=everyone (set and remove)', function () {
    [$tony, $tonyToken] = loginAs($this->tony);
    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $this->room->forceFill(['settings' => ['who_can_edit_info' => 'everyone']])->save();

    $id = uploadRoomAvatar($this, $tonyToken, 'group.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($tonyToken, 'acme'))
        ->assertOk();

    // member cannot replace it — and nothing else in the payload sneaks through
    $foreign = uploadRoomAvatar($this, $somchaiToken, 'somchai.png', 'image/png', $this->png);

    $this->patchJson("/api/v1/rooms/{$this->room->id}", [
        'name' => 'Hax',
        'avatar_attachment_id' => $foreign,
    ], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');

    // member cannot remove it either
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => null], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_FORBIDDEN');

    $fresh = $this->room->fresh();
    expect($fresh->avatar_attachment_id)->toBe($id)
        ->and($fresh->name)->toBe('Engineering')
        ->and(Message::query()->where('room_id', $this->room->id)->where('type', 'system')->count())->toBe(1); // only the owner's set
});

// ---- id validation ----

test('TC-ROOM-086 foreign / pending / non-avatar-kind / unknown id → 422 AVATAR_INVALID, unknown == foreign body', function () {
    [$tony, $tonyToken] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);

    // someone else's ready avatar
    $foreign = uploadRoomAvatar($this, $somchaiToken, 'somchai.png', 'image/png', $this->png);

    $foreignBody = $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $foreign], wsHeaders($tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID')
        ->json('error');

    // unknown id → the SAME opaque body (no enumeration); only request_id may differ
    $unknown = $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => (string) Str::ulid()], wsHeaders($tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID')
        ->json('error');

    expect([$unknown['code'], $unknown['message']])->toBe([$foreignBody['code'], $foreignBody['message']]);

    // own attachment but wrong kind (a chat image, not an avatar)
    $image = $this->postJson('/api/v1/uploads', [
        'kind' => 'image', 'filename' => 'cat.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($this->png),
    ], wsHeaders($tonyToken, 'acme'))->json('data');
    $this->call('PUT', $image['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $this->png)->assertOk();
    $this->postJson("/api/v1/uploads/{$image['attachment_id']}/complete", [], wsHeaders($tonyToken, 'acme'))->assertOk();

    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $image['attachment_id']], wsHeaders($tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID');

    // own avatar ticket that never completed (still pending)
    $pending = $this->postJson('/api/v1/uploads', [
        'kind' => 'avatar', 'filename' => 'pending.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($this->png),
    ], wsHeaders($tonyToken, 'acme'))->json('data');

    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $pending['attachment_id']], wsHeaders($tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID');

    // nothing was written by any of the rejected attempts
    expect($this->room->fresh()->avatar_attachment_id)->toBeNull()
        ->and(Message::query()->where('room_id', $this->room->id)->where('type', 'system')->count())->toBe(0);
});

test('TC-ROOM-087 member re-sending the CURRENT id is a harmless no-op — no 403, no system message', function () {
    [$tony, $tonyToken] = loginAs($this->tony);
    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $id = uploadRoomAvatar($this, $tonyToken, 'group.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($tonyToken, 'acme'))
        ->assertOk();

    // a plain member re-sending the same value is NOT an avatar change
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($somchaiToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.avatar_attachment_id', $id);

    expect(Message::query()->where('room_id', $this->room->id)->where('type', 'system')->count())->toBe(1)
        ->and($this->room->fresh()->avatar_attachment_id)->toBe($id);
});

test('TC-ROOM-088 owner removes the photo with null → 200, avatar null, another system message', function () {
    [$tony, $token] = loginAs($this->tony);

    $id = uploadRoomAvatar($this, $token, 'group.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))
        ->assertOk();

    $room = $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => null], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.room');

    expect($room['avatar_attachment_id'])->toBeNull()
        ->and($room['avatar'])->toBeNull()
        ->and($this->room->fresh()->avatar_attachment_id)->toBeNull();

    $events = Message::query()->where('room_id', $this->room->id)->where('type', 'system')
        ->orderBy('seq')->pluck('system_event');

    expect($events->count())->toBe(2)
        ->and($events->values()->get(1))->toBe(['event' => 'room_avatar_changed']);
});

test('TC-ROOM-089 GIF group photo → animated carries the signed original, thumbs stay webp stills', function () {
    [$tony, $token] = loginAs($this->tony);
    $gif = roomAvatarGif();

    $id = uploadRoomAvatar($this, $token, 'group.gif', 'image/gif', $gif);

    // the original object is byte-identical to what was uploaded (never re-encoded)
    expect(Storage::disk('local')->get('ws/'.$this->ws->id.'/att/'.$id.'/original'))->toBe($gif);

    $room = $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.room');

    expect($room['avatar']['animated'])->toStartWith('http');

    $this->get($room['avatar']['animated'])->assertOk()->assertHeader('Content-Type', 'image/gif');
    $this->get($room['avatar']['sm'])->assertOk()->assertHeader('Content-Type', 'image/webp');
});

// ---- serialization on every room payload, no N+1 ----

test('TC-ROOM-090 list, show and store carry room.avatar; list query count does not grow with room count', function () {
    [$tony, $token] = loginAs($this->tony);

    // the beforeEach room joins the page too — give it a photo as well
    $baseId = uploadRoomAvatar($this, $token, 'base.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $baseId], wsHeaders($token, 'acme'))
        ->assertOk();

    $makeRoomsWithPhotos = function (int $count) use ($token): array {
        for ($i = 0; $i < $count; $i++) {
            $room = makeAvatarGroup($this->ws, $this->tony);
            $id = uploadRoomAvatar($this, $token, "g{$i}.png", 'image/png', $this->png);
            $this->patchJson("/api/v1/rooms/{$room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))->assertOk();
        }

        $countList = function () use ($token): array {
            DB::flushQueryLog();
            DB::enableQueryLog();
            $rows = $this->getJson('/api/v1/rooms?limit=50', wsHeaders($token, 'acme'))
                ->assertOk()->json('data');
            DB::disableQueryLog();

            return [count(DB::getQueryLog()), $rows];
        };

        return $countList();
    };

    [$queriesWith4, $rows4] = $makeRoomsWithPhotos(3);
    [$queriesWith7, $rows7] = $makeRoomsWithPhotos(3);

    // one batched avatar query whatever the page size (DM peers + group photos)
    expect(count($rows7))->toBe(7)
        ->and($queriesWith7)->toBe($queriesWith4);

    foreach ($rows7 as $row) {
        expect($row['room']['avatar'])->not->toBeNull()
            ->and($row['room']['avatar']['sm'])->toStartWith('http')
            ->and($row['room']['avatar']['animated'])->toBeNull();
    }

    // show carries it too
    $roomId = $rows7[0]['room']['id'];
    $this->getJson("/api/v1/rooms/{$roomId}", wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.avatar.sm', fn ($sm) => str_starts_with((string) $sm, 'http'));

    // a fresh room from POST /rooms has the key, null (photo is set later)
    $store = $this->postJson('/api/v1/rooms', [
        'type' => 'group',
        'name' => 'Fresh',
        'member_ids' => [$this->somchai->id],
    ], wsHeaders($token, 'acme'))
        ->assertCreated()
        ->json('data');

    expect(array_key_exists('avatar', $store['room']))->toBeTrue()
        ->and($store['room']['avatar'])->toBeNull();
});

// ---- DM stays immutable and avatar-free ----

test('TC-ROOM-091 DM rejects the photo and serializes avatar null (peer photo is other_user.avatar)', function () {
    [$tony, $token] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);

    $id = uploadRoomAvatar($this, $token, 'group.png', 'image/png', $this->png);

    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'))
        ->assertCreated()->json('data.room');

    $this->patchJson("/api/v1/rooms/{$dm['id']}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'ROOM_DM_IMMUTABLE');

    // somchai sets his OWN photo; the DM rows show his, never a room avatar
    $userPhoto = uploadRoomAvatar($this, $somchaiToken, 'somchai.png', 'image/png', $this->png);
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $userPhoto], authHeaders($somchaiToken))->assertOk();

    $this->getJson("/api/v1/rooms/{$dm['id']}", wsHeaders($token, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.room.avatar', null)
        ->assertJsonPath('data.room.avatar_attachment_id', null);

    $rows = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'))->assertOk()->json('data');
    $dmRow = collect($rows)->first(fn ($r) => $r['room']['id'] === $dm['id']);
    $groupRow = collect($rows)->first(fn ($r) => $r['room']['id'] === $this->room->id);

    expect($dmRow['room']['avatar'])->toBeNull()
        ->and($dmRow['other_user']['avatar'])->not->toBeNull()
        ->and($dmRow['other_user']['avatar']['sm'])->toStartWith('http')
        ->and($groupRow['room']['avatar'])->toBeNull(); // no photo set on this group
});

// ---- DEC-087: no avatar URL ever reaches a push payload ----

test('TC-ROOM-092 NotifyMessage FCM payload contains no room avatar URL even with photos set (DEC-087)', function () {
    config([
        'services.fcm.project_id' => 'test-project',
        'services.fcm.credentials' => json_encode([
            'client_email' => 'push@test-project.iam.gserviceaccount.com',
            'private_key' => roomAvatarServiceAccountKey(),
            'token_uri' => 'https://oauth2.googleapis.com/token',
        ]),
    ]);
    Cache::forget('fcm:token:'.sha1('push@test-project.iam.gserviceaccount.com'));

    [$tony, $token] = loginAs($this->tony);

    $id = uploadRoomAvatar($this, $token, 'group.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))
        ->assertOk();

    Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'tok-room-1', 'push_provider' => 'fcm',
    ]);

    Http::fake([
        'oauth2.googleapis.com/*' => Http::response(['access_token' => 'tok', 'expires_in' => 3600]),
        'fcm.googleapis.com/*' => Http::response(['name' => 'projects/test-project/messages/1'], 200),
    ]);

    $sent = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'push me',
    ], wsHeaders($token, 'acme'))->assertCreated()->json('data.message');

    (new NotifyMessage($sent['id']))->handle(app(PushDecisionService::class), app(FcmPushSender::class));

    Http::assertSent(function (HttpRequest $request) {
        if (! str_contains($request->url(), 'fcm.googleapis.com')) {
            return false;
        }

        $body = (string) $request->body();

        return ! str_contains($body, 'avatar')
            && ! str_contains($body, '/att/')
            && str_contains($body, 'push me');
    });
});

// ---- ws admin outranks room roles, but membership is still required ----

test('TC-ROOM-093 ws admin non-member still gets 403 ROOM_NOT_MEMBER (current behaviour kept)', function () {
    [$tony, $token] = loginAs($this->tony);
    [$anna, $annaToken] = loginAs($this->anna); // ws admin, NOT a member of this one

    $room = makeAvatarGroup($this->ws, $this->tony, [
        ['user' => $this->somchai, 'role' => RoomRole::Member],
    ]);

    $id = uploadRoomAvatar($this, $annaToken, 'anna.png', 'image/png', $this->png);

    $this->patchJson("/api/v1/rooms/{$room->id}", ['avatar_attachment_id' => $id], wsHeaders($annaToken, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');

    expect($room->fresh()->avatar_attachment_id)->toBeNull();
});

test('TC-ROOM-094 room list preview names the photo change instead of going blank', function () {
    [, $token] = loginAs($this->tony);
    $id = uploadRoomAvatar($this, $token, 'preview.png', 'image/png', $this->png);
    $this->patchJson("/api/v1/rooms/{$this->room->id}", ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))->assertOk();

    $row = collect($this->getJson('/api/v1/rooms?limit=50', wsHeaders($token, 'acme'))->assertOk()->json('data'))
        ->firstWhere('room.id', $this->room->id);

    expect($row['last_message']['type'])->toBe('system')
        ->and($row['last_message']['body'])->toBe('🖼️ เปลี่ยนรูปกลุ่ม');
});
