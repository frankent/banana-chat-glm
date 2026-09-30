<?php

use App\Domain\Media\MediaUrls;
use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Events\UserSettingsUpdated;
use App\Events\UserUpdated;
use App\Jobs\NotifyMessage;
use App\Jobs\PurgeOrphanAttachments;
use App\Models\Attachment;
use App\Models\Device;
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
 * TC-PROF-006.. — user avatar upload + set/remove + serialization + events
 * (FR-PROF-006, API-009 amended, EVT-087, DEC-088, spec 1.16.6).
 *
 * Local disk (pinned in phpunit.xml): signed urls point at the signed API
 * routes the same way UploadTest exercises them.
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
    $this->ws->members()->attach($this->anna->id, ['role' => 'member']);

    $this->room = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 3,
        'last_message_at' => now(),
    ]);

    foreach ([$this->tony, $this->somchai, $this->anna] as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $i === 0 ? 'owner' : 'member',
            'added_by' => $this->tony->id,
        ]);
    }

    $this->png = avatarPng();
});

/**
 * Minimal GD fixtures (unique names — UploadTest owns tinyPng()).
 */
function avatarPng(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/**
 * Throwaway RSA key for the FCM service-account assertion (unique name —
 * PushTest owns testServiceAccountKey()).
 */
function avatarServiceAccountKey(): string
{
    static $pem = null;
    if ($pem === null) {
        $res = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($res, $pem);
    }

    return $pem;
}

function avatarGif(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagegif($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/**
 * Upload → PUT → complete, returning [attachment_id, serialized attachment].
 */
function uploadAvatar($test, string $token, string $filename, string $mime, string $bytes): array
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

    $done = $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.attachment');

    return [$created['attachment_id'], $done];
}

/** Set the caller's avatar over PATCH /me and return the response JSON. */
function setAvatar($test, string $token, string $attachmentId): array
{
    return $test->patchJson('/api/v1/me', ['avatar_attachment_id' => $attachmentId], authHeaders($token))
        ->assertOk()
        ->json('data.user');
}

// ---- upload surface (kind avatar) ----

test('TC-PROF-006 upload kind avatar png → ready with webp thumbs', function () {
    [$user, $token] = loginAs($this->tony);

    [$id, $attachment] = uploadAvatar($this, $token, 'me.png', 'image/png', $this->png);

    expect($attachment['kind'])->toBe('avatar')
        ->and($attachment['status'])->toBe('ready')
        ->and($attachment['urls']['thumb_sm'])->not->toBeNull()
        ->and($attachment['urls']['thumb_md'])->not->toBeNull();
});

test('TC-PROF-007 upload kind avatar gif → ready, original kept (animation survives)', function () {
    [$user, $token] = loginAs($this->tony);
    $gif = avatarGif();

    [$id, $attachment] = uploadAvatar($this, $token, 'me.gif', 'image/gif', $gif);

    expect($attachment['status'])->toBe('ready')
        ->and($attachment['mime_type'])->toBe('image/gif')
        // the original object is byte-identical to what was uploaded
        ->and(Storage::disk('local')->get('ws/'.$this->ws->id.'/att/'.$id.'/original'))->toBe($gif);
});

test('TC-PROF-008 avatar over upload.avatar.max_bytes (5MB) → 422 MEDIA_TOO_LARGE', function () {
    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/uploads', [
        'kind' => 'avatar',
        'filename' => 'huge.png',
        'mime_type' => 'image/png',
        'size_bytes' => 5242881,
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_TOO_LARGE')
        ->assertJsonPath('error.details.max_bytes', 5242880);
});

test('TC-PROF-009 avatar sniffed mime outside jpeg/png/webp/gif → 422 MEDIA_MIME_MISMATCH', function () {
    [$user, $token] = loginAs($this->tony);

    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'avatar',
        'filename' => 'me.svg',
        'mime_type' => 'image/svg+xml',
        'size_bytes' => strlen($svg),
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data');

    $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $svg)->assertOk();

    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');
});

// ---- PATCH /me set / clear ----

test('TC-PROF-010 PATCH /me with own ready avatar → 200, avatar.sm/md signed, animated null (png)', function () {
    [$user, $token] = loginAs($this->tony);

    [$id] = uploadAvatar($this, $token, 'me.png', 'image/png', $this->png);
    $me = setAvatar($this, $token, $id);

    expect($me['avatar_attachment_id'])->toBe($id)
        ->and($me['avatar'])->not->toBeNull()
        ->and($me['avatar']['sm'])->toStartWith('http')
        ->and($me['avatar']['md'])->toStartWith('http')
        ->and($me['avatar']['sm'])->not->toBe($me['avatar']['md'])
        ->and($me['avatar']['animated'])->toBeNull();

    // the sm thumb actually serves the webp bytes
    $sm = $this->get($me['avatar']['sm']);
    $sm->assertOk()->assertHeader('Content-Type', 'image/webp');
});

test('TC-PROF-011 PATCH /me with gif avatar → animated carries the signed original', function () {
    [$user, $token] = loginAs($this->tony);

    [$id] = uploadAvatar($this, $token, 'me.gif', 'image/gif', avatarGif());
    $me = setAvatar($this, $token, $id);

    expect($me['avatar']['animated'])->toStartWith('http');

    $animated = $this->get($me['avatar']['animated']);
    $animated->assertOk()->assertHeader('Content-Type', 'image/gif');
});

test('TC-PROF-012 PATCH /me foreign / unknown / non-avatar / pending → 422 AVATAR_INVALID, unknown == foreign body', function () {
    [$user, $token] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);

    // someone else's ready avatar
    [$foreignId] = uploadAvatar($this, $somchaiToken, 'somchai.png', 'image/png', $this->png);

    $foreign = $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $foreignId], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID')
        ->json('error');

    // unknown id → the SAME opaque body (no enumeration); only the
    // per-response request_id may differ
    $unknown = $this->patchJson('/api/v1/me', ['avatar_attachment_id' => (string) Str::ulid()], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID')
        ->json('error');

    expect([$unknown['code'], $unknown['message']])->toBe([$foreign['code'], $foreign['message']]);

    // own attachment but wrong kind (a chat image, not an avatar)
    $image = $this->postJson('/api/v1/uploads', [
        'kind' => 'image', 'filename' => 'cat.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->json('data');
    $this->call('PUT', $image['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $this->png)->assertOk();
    $this->postJson("/api/v1/uploads/{$image['attachment_id']}/complete", [], wsHeaders($token, 'acme'))->assertOk();

    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $image['attachment_id']], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID');

    // own avatar ticket that never completed (still pending)
    $pending = $this->postJson('/api/v1/uploads', [
        'kind' => 'avatar', 'filename' => 'pending.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->json('data');

    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $pending['attachment_id']], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AVATAR_INVALID');

    // nothing was written by any of the rejected attempts
    expect($this->tony->refresh()->avatar_attachment_id)->toBeNull();
});

test('TC-PROF-013 PATCH /me null clears the avatar', function () {
    [$user, $token] = loginAs($this->tony);

    [$id] = uploadAvatar($this, $token, 'me.png', 'image/png', $this->png);
    setAvatar($this, $token, $id);

    $me = $this->patchJson('/api/v1/me', ['avatar_attachment_id' => null], authHeaders($token))
        ->assertOk()
        ->json('data.user');

    expect($me['avatar_attachment_id'])->toBeNull()
        ->and($me['avatar'])->toBeNull()
        ->and($this->tony->refresh()->avatar_attachment_id)->toBeNull();
});

// ---- EVT-086 + EVT-087 broadcast only on a real change ----

test('TC-PROF-014 user.updated broadcast to every active workspace + user.updated on private-user, only on change', function () {
    Event::fake([UserUpdated::class, UserSettingsUpdated::class]);

    [$user, $token] = loginAs($this->tony);

    $otherWs = Workspace::factory()->create(['slug' => 'globex']);
    $otherWs->members()->attach($this->tony->id, ['role' => 'member']);

    // display_name change → both events
    $this->patchJson('/api/v1/me', ['display_name' => 'Tony II'], authHeaders($token))->assertOk();

    Event::assertDispatchedTimes(UserUpdated::class, 1);
    Event::assertDispatched(UserUpdated::class, function (UserUpdated $e) use ($otherWs) {
        $channels = array_map(fn ($c) => $c->__toString(), $e->channels());
        $payload = $e->broadcastWith();

        return in_array("workspace.{$this->ws->id}", $channels, true)
            && in_array("workspace.{$otherWs->id}", $channels, true)
            && count($channels) === 2
            && $payload['event'] === 'user.updated'
            && $payload['workspace_id'] === null
            && $payload['data'] === ['user_id' => $this->tony->id]
            && isset($payload['emitted_at']);
    });
    Event::assertDispatchedTimes(UserSettingsUpdated::class, 1);

    // avatar change → both events again
    [$id] = uploadAvatar($this, $token, 'me.png', 'image/png', $this->png);
    Event::fake([UserUpdated::class, UserSettingsUpdated::class]); // reset counters
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $id], authHeaders($token))->assertOk();

    Event::assertDispatchedTimes(UserUpdated::class, 1);
    Event::assertDispatchedTimes(UserSettingsUpdated::class, 1);

    // no-op writes broadcast nothing: same display_name, same avatar id, locale-only
    Event::fake([UserUpdated::class, UserSettingsUpdated::class]);
    $this->patchJson('/api/v1/me', ['display_name' => 'Tony II'], authHeaders($token))->assertOk();
    $this->patchJson('/api/v1/me', ['avatar_attachment_id' => $id], authHeaders($token))->assertOk();
    $this->patchJson('/api/v1/me', ['locale' => 'en'], authHeaders($token))->assertOk();

    Event::assertNotDispatched(UserUpdated::class);
    Event::assertNotDispatched(UserSettingsUpdated::class);
});

// ---- serialized shape on every list ----

test('TC-PROF-015 avatar object on message sender, members list, read receipts and DM counterpart', function () {
    [$user, $token] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);
    [, $annaToken] = loginAs($this->anna);

    $tokens = ['tony' => $token, 'somchai' => $somchaiToken, 'anna' => $annaToken];
    $ids = [];
    foreach ([$this->tony, $this->somchai, $this->anna] as $u) {
        [$id] = uploadAvatar($this, $tokens[$u->username], $u->username.'.png', 'image/png', $this->png);
        setAvatar($this, $tokens[$u->username], $id);
        $ids[$u->id] = $id;
    }

    foreach ([$this->tony, $this->somchai, $this->anna] as $u) {
        $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
            'client_message_id' => (string) Str::uuid(),
            'body' => 'hello from '.$u->username,
        ], wsHeaders($tokens[$u->username], 'acme'))->assertCreated();
    }

    // message list — sender.avatar
    $messages = $this->getJson("/api/v1/rooms/{$this->room->id}/messages", wsHeaders($token, 'acme'))
        ->assertOk()->json('data.messages');

    expect(count($messages))->toBe(3);
    foreach ($messages as $m) {
        expect($m['sender']['avatar_attachment_id'])->toBe($ids[$m['sender']['id']])
            ->and($m['sender']['avatar'])->not->toBeNull()
            ->and($m['sender']['avatar']['sm'])->toStartWith('http')
            ->and($m['sender']['avatar']['md'])->toStartWith('http')
            ->and($m['sender']['avatar']['animated'])->toBeNull();
    }

    // workspace members list
    $members = $this->getJson('/api/v1/members', wsHeaders($token, 'acme'))
        ->assertOk()->json('data');

    foreach ($members as $m) {
        expect($m['avatar'])->not->toBeNull()->and($m['avatar']['sm'])->toStartWith('http');
    }

    // room member list
    $roomMembers = $this->getJson("/api/v1/rooms/{$this->room->id}/members", wsHeaders($token, 'acme'))
        ->assertOk()->json('data');

    foreach ($roomMembers as $m) {
        expect($m['avatar'])->not->toBeNull();
    }

    // read receipts (somchai explicitly reads up to the top)
    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 3], wsHeaders($somchaiToken, 'acme'))
        ->assertOk();

    $readBy = $this->getJson("/api/v1/rooms/{$this->room->id}/read-status", wsHeaders($token, 'acme'))
        ->assertOk()->json('data.read_by');

    expect(count($readBy))->toBeGreaterThanOrEqual(1);
    foreach ($readBy as $r) {
        expect($r['avatar'])->not->toBeNull()->and($r['avatar']['sm'])->toStartWith('http');
    }

    // DM counterpart
    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'))
        ->assertCreated()->json('data.room');

    $rooms = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'))->assertOk()->json('data');
    $dmRow = collect($rooms)->first(fn ($r) => $r['room']['id'] === $dm['id']);

    expect($dmRow['other_user']['id'])->toBe($this->somchai->id)
        ->and($dmRow['other_user']['avatar'])->not->toBeNull()
        ->and($dmRow['other_user']['avatar']['sm'])->toStartWith('http');

    // search results for people-visible messages carry sender.avatar too
    $hit = $this->getJson('/api/v1/search/messages?q=hello', wsHeaders($token, 'acme'))
        ->assertOk()->json('data.results.0.message');

    expect($hit['sender']['avatar'])->not->toBeNull();
});

// ---- no N+1 on the message list ----

test('TC-PROF-016 message list query count does not grow with message count (3 senders with avatars)', function () {
    [$tonyUser, $token] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);
    [, $annaToken] = loginAs($this->anna);

    $tokens = ['tony' => $token, 'somchai' => $somchaiToken, 'anna' => $annaToken];
    foreach ([$this->tony, $this->somchai, $this->anna] as $u) {
        [$id] = uploadAvatar($this, $tokens[$u->username], $u->username.'.png', 'image/png', $this->png);
        setAvatar($this, $tokens[$u->username], $id);
    }

    $sendBatch = function (int $count) use ($tokens): void {
        for ($i = 0; $i < $count; $i++) {
            $u = [$this->tony, $this->somchai, $this->anna][$i % 3];
            $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
                'client_message_id' => (string) Str::uuid(),
                'body' => "msg {$i}",
            ], wsHeaders($tokens[$u->username], 'acme'))->assertCreated();
        }
    };

    $countQueries = function () use ($token): array {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $page = $this->getJson("/api/v1/rooms/{$this->room->id}/messages?limit=50", wsHeaders($token, 'acme'))
            ->assertOk()->json('data.messages');
        DB::disableQueryLog();

        return [count(DB::getQueryLog()), count($page)];
    };

    $sendBatch(6);
    [$queriesWith6, $messages6] = $countQueries();

    $sendBatch(12); // 18 total, same three senders
    [$queriesWith18, $messages18] = $countQueries();

    expect($messages6)->toBe(6)->and($messages18)->toBe(18);
    expect($queriesWith18)->toBe($queriesWith6); // sender avatar adds ONE batched load, not one per message
});

// ---- replaced avatars are reclaimed, current ones never ----

test('TC-PROF-017 PurgeOrphanAttachments reclaims a replaced avatar past grace, keeps the current one', function () {
    [$user, $token] = loginAs($this->tony);

    [$oldId] = uploadAvatar($this, $token, 'old.png', 'image/png', $this->png);
    setAvatar($this, $token, $oldId);

    [$newId] = uploadAvatar($this, $token, 'new.png', 'image/png', $this->png);
    setAvatar($this, $token, $newId);

    // the replaced photo is now past the grace window; the current one is
    // even OLDER — being referenced is what protects it, not its age.
    Attachment::withoutGlobalScopes()->find($oldId)
        ->forceFill(['created_at' => now()->subHours(PurgeOrphanAttachments::AVATAR_ORPHAN_GRACE_HOURS + 1)])->save();
    Attachment::withoutGlobalScopes()->find($newId)
        ->forceFill(['created_at' => now()->subHours(PurgeOrphanAttachments::AVATAR_ORPHAN_GRACE_HOURS + 6)])->save();

    (new PurgeOrphanAttachments)->handle();

    $oldKey = 'ws/'.$this->ws->id.'/att/'.$oldId;
    $newKey = 'ws/'.$this->ws->id.'/att/'.$newId;

    // the replaced photo is GONE — row, original and thumbs
    expect(Attachment::withoutGlobalScopes()->find($oldId))->toBeNull()
        ->and(Storage::disk('local')->exists($oldKey.'/original'))->toBeFalse()
        ->and(Storage::disk('local')->exists($oldKey.'/thumb_sm'))->toBeFalse()
        ->and(Storage::disk('local')->exists($oldKey.'/thumb_md'))->toBeFalse()
        // the current one SURVIVES despite being the older row — being
        // referenced is what protects it, not its age
        ->and(Attachment::withoutGlobalScopes()->find($newId))->not->toBeNull()
        ->and(Storage::disk('local')->exists($newKey.'/original'))->toBeTrue()
        ->and(Storage::disk('local')->exists($newKey.'/thumb_sm'))->toBeTrue()
        ->and($this->tony->refresh()->avatar_attachment_id)->toBe($newId);
});

test('TC-PROF-019 PurgeOrphanAttachments keeps kind=avatar rows used as a room or workspace photo', function () {
    [, $token] = loginAs($this->tony);

    [$roomPhoto] = uploadAvatar($this, $token, 'room.png', 'image/png', $this->png);
    [$wsPhoto] = uploadAvatar($this, $token, 'ws.png', 'image/png', $this->png);
    $room = \App\Models\Room::withoutGlobalScopes()->where('workspace_id', $this->ws->id)->firstOrFail();
    \Illuminate\Support\Facades\DB::table('rooms')->where('id', $room->id)->update(['avatar_attachment_id' => $roomPhoto]);
    \Illuminate\Support\Facades\DB::table('workspaces')->where('id', $this->ws->id)->update(['avatar_attachment_id' => $wsPhoto]);
    foreach ([$roomPhoto, $wsPhoto] as $id) {
        Attachment::withoutGlobalScopes()->find($id)
            ->forceFill(['created_at' => now()->subHours(PurgeOrphanAttachments::AVATAR_ORPHAN_GRACE_HOURS + 6)])->save();
    }

    (new PurgeOrphanAttachments)->handle();

    expect(Attachment::withoutGlobalScopes()->find($roomPhoto))->not->toBeNull()
        ->and(Attachment::withoutGlobalScopes()->find($wsPhoto))->not->toBeNull()
        ->and(Storage::disk('local')->exists('ws/'.$this->ws->id.'/att/'.$roomPhoto.'/original'))->toBeTrue();
});

// ---- DEC-087: no avatar URL ever reaches a push payload ----

test('TC-PROF-018 NotifyMessage FCM payload contains no avatar URL (DEC-087)', function () {
    config([
        'services.fcm.project_id' => 'test-project',
        'services.fcm.credentials' => json_encode([
            'client_email' => 'push@test-project.iam.gserviceaccount.com',
            'private_key' => avatarServiceAccountKey(),
            'token_uri' => 'https://oauth2.googleapis.com/token',
        ]),
    ]);
    Cache::forget('fcm:token:'.sha1('push@test-project.iam.gserviceaccount.com'));

    [$user, $token] = loginAs($this->tony);
    [, $somchaiToken] = loginAs($this->somchai);

    [$id] = uploadAvatar($this, $token, 'me.png', 'image/png', $this->png);
    setAvatar($this, $token, $id);

    Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'tok-plain-1', 'push_provider' => 'fcm',
    ]);

    // fake BEFORE the send: with QUEUE_CONNECTION=sync the fan-out runs inside
    // the request, so the recorded FCM request is the inline one either way
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

        // assert on the JSON STRING: whatever shape FCM re-arranges it into,
        // no avatar key and no signed media path may appear anywhere in it
        $body = (string) $request->body();

        return ! str_contains($body, 'avatar')
            && ! str_contains($body, '/att/')
            && str_contains($body, 'push me');
    });
});
