<?php

use App\Domain\Media\MediaUrls;
use App\Enums\RoomRole;
use App\Events\CallChanged;
use App\Events\RoomDeleted;
use App\Jobs\ExpireSecretRooms;
use App\Jobs\PurgeAttachmentFiles;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * TC-ROOM-070..083 — secret rooms (FR-ROOM-012 / DEC-056): creation with
 * 1..30-day expiry, secret-DM namespace separation from the canonical DM,
 * immediate all-surface denial at expiry (read/write/media/call/realtime/
 * search/unread), presigned-URL TTL capping, scheduler purge through the
 * existing lifecycle (including soft-deleted rooms and SFU outages), and
 * ordinary-room preservation.
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);
    $this->anna = User::factory()->create(['username' => 'anna']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);
    $this->ws->members()->attach($this->anna->id, ['role' => 'member']);
});

/**
 * Direct-model secret room fixture (API creation paths are tested below).
 */
function makeSecretRoom(Workspace $ws, User $owner, array $members = [], ?int $expiryDays = 7, ?int $expiryMinutes = null): Room
{
    $expiresAt = $expiryMinutes !== null ? now()->addMinutes($expiryMinutes) : now()->addDays($expiryDays ?? 7);

    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => 'Burner',
        'created_by' => $owner->id,
        'owner_id' => $owner->id,
        'member_count' => count($members) + 1,
        'last_message_at' => now(),
        'is_secret' => true,
        'secret_expires_at' => $expiresAt,
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

/** Ordinary room fixture — must stay bit-for-bit unaffected throughout. */
function makeOrdinaryRoom(Workspace $ws, User $owner, array $members = []): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => 'Evergreen',
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

function seedMessage(Room $room, User $sender, string $body): Message
{
    $message = Message::query()->create([
        'room_id' => $room->id,
        'workspace_id' => $room->workspace_id,
        'sender_id' => $sender->id,
        'seq' => (int) $room->last_seq + 1,
        'type' => 'text',
        'body' => $body,
        'client_message_id' => (string) Str::uuid(),
    ]);

    $room->forceFill([
        'last_seq' => $message->seq,
        'last_user_seq' => $message->seq,
        'last_message_id' => $message->id,
        'last_message_at' => now(),
    ])->save();

    return $message;
}

function secretTinyPng(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

/**
 * Auth expires on two independent clocks: the access token (60 min) and the
 * login session that owns it (30 d rolling — TokenService::resolveAccessToken
 * rejects the bearer when the session is past `expires_at`). Every test that
 * time-travels must push BOTH out, or auth fails before the room logic runs.
 */
function extendTokens(User ...$users): void
{
    foreach ($users as $user) {
        DB::table('access_tokens')
            ->where('user_id', $user->id)
            ->whereNull('revoked_at')
            ->update(['expires_at' => now()->addYears(10)]);

        DB::table('sessions')
            ->where('user_id', $user->id)
            ->whereNull('revoked_at')
            ->update(['expires_at' => now()->addYears(10)]);
    }
}

// ---------------------------------------------------------------------------
// Creation + validation
// ---------------------------------------------------------------------------

test('TC-ROOM-070 secret DM → 201, distinct from the canonical ordinary DM', function () {
    [$user, $token] = loginAs($this->tony);

    $ordinary = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], wsHeaders($token, 'acme'))
        ->assertStatus(201)
        ->assertJsonPath('data.room.is_secret', false)
        ->assertJsonPath('data.room.secret_expires_at', null)
        ->json('data.room.id');

    $secret = $this->postJson('/api/v1/rooms', [
        'type' => 'dm',
        'user_id' => $this->somchai->id,
        'secret' => true,
        'expiry_days' => 7,
    ], wsHeaders($token, 'acme'))
        ->assertStatus(201)
        ->assertJsonPath('data.room.is_secret', true)
        ->json('data.room.id');

    expect($secret)->not->toBe($ordinary);

    // both rooms coexist; the ordinary DM is untouched and still dedupes
    $again = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->tony->id], wsHeaders(loginAs($this->somchai)[1], 'acme'))
        ->assertStatus(200)
        ->json('data.room.id');
    expect($again)->toBe($ordinary);

    // secret DM dedupes within its own namespace while alive
    $secretAgain = $this->postJson('/api/v1/rooms', [
        'type' => 'dm',
        'user_id' => $this->somchai->id,
        'secret' => true,
        'expiry_days' => 30, // different expiry does NOT fork a second room
    ], wsHeaders($token, 'acme'))
        ->assertStatus(200)
        ->json('data.room.id');
    expect($secretAgain)->toBe($secret);
});

test('TC-ROOM-071 secret group → 201, expiry = creation + expiry_days, members join', function () {
    [$user, $token] = loginAs($this->tony);

    $before = now();
    $response = $this->postJson('/api/v1/rooms', [
        'type' => 'group',
        'name' => 'Project X',
        'member_ids' => [$this->somchai->id],
        'secret' => true,
        'expiry_days' => 30,
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    $roomId = $response->json('data.room.id');
    $room = Room::query()->findOrFail($roomId);

    expect($room->is_secret)->toBeTrue()
        ->and($room->secret_expires_at)->not->toBeNull()
        ->and($room->secret_expires_at->betweenIncluded($before->copy()->addDays(30)->subSeconds(5), $before->copy()->addDays(30)->addSeconds(5)))->toBeTrue()
        ->and($response->json('data.room.is_secret'))->toBeTrue()
        ->and(RoomMember::query()->where('room_id', $roomId)->count())->toBe(2);
});

test('TC-ROOM-072 expiry_days validation — 0/31/non-int/missing rejected, boundaries 1 and 30 accepted', function () {
    [$user, $token] = loginAs($this->tony);
    $headers = wsHeaders($token, 'acme');

    foreach ([0, 31, -1, 'abc', 2.5] as $bad) {
        $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => $bad], $headers)
            ->assertStatus(422);
    }

    // secret without expiry → 422; expiry without secret → 422
    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true], $headers)->assertStatus(422);
    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id, 'expiry_days' => 5], $headers)->assertStatus(422);

    // both boundaries create (different partners so the secret-DM dedupe
    // cannot turn the second create into a 200)
    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => 1], $headers)
        ->assertStatus(201);
    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->anna->id, 'secret' => true, 'expiry_days' => 30], $headers)
        ->assertStatus(201);

    // group variant enforces the same rules
    $this->postJson('/api/v1/rooms', ['type' => 'group', 'name' => 'X', 'secret' => true, 'expiry_days' => 45], $headers)->assertStatus(422);
    $this->postJson('/api/v1/rooms', ['type' => 'group', 'name' => 'X', 'secret' => true, 'expiry_days' => 3], $headers)->assertStatus(201);
});

// ---------------------------------------------------------------------------
// Boundary: one second before vs. at expiry
// ---------------------------------------------------------------------------

test('TC-ROOM-073 expiry boundary — usable until the last second, denied from the exact expiry instant', function () {
    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');

    $roomId = $this->postJson('/api/v1/rooms', [
        'type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => 1,
    ], $headers)->assertStatus(201)->json('data.room.id');

    $this->postJson("/api/v1/rooms/{$roomId}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => 'still alive'], $headers)
        ->assertStatus(201);

    $expiresAt = Room::query()->findOrFail($roomId)->secret_expires_at;

    // one second before expiry: full access
    $this->travelTo($expiresAt->copy()->subSecond());
    $this->postJson("/api/v1/rooms/{$roomId}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => 'last word'], $headers)
        ->assertStatus(201);
    $this->getJson("/api/v1/rooms/{$roomId}/messages", $headers)->assertStatus(200);
    $this->getJson("/api/v1/rooms/{$roomId}", $headers)->assertStatus(200);

    // at the expiry instant: every surface denies with 410 ROOM_EXPIRED
    $this->travelTo($expiresAt);

    $this->getJson("/api/v1/rooms/{$roomId}", $headers)
        ->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
    $this->getJson("/api/v1/rooms/{$roomId}/messages", $headers)
        ->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
    $this->postJson("/api/v1/rooms/{$roomId}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => 'too late'], $headers)
        ->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
    $this->postJson("/api/v1/rooms/{$roomId}/read", ['seq' => 2], $headers)->assertStatus(410);
    $this->getJson("/api/v1/rooms/{$roomId}/read-status", $headers)->assertStatus(410);
    $this->getJson("/api/v1/rooms/{$roomId}/members", $headers)->assertStatus(410);
    $this->postJson("/api/v1/rooms/{$roomId}/members", ['user_ids' => [$this->anna->id]], $headers)->assertStatus(410);
    $this->getJson("/api/v1/rooms/{$roomId}/notes", $headers)->assertStatus(410);
    $this->postJson("/api/v1/rooms/{$roomId}/notes", ['body' => 'note'], $headers)->assertStatus(410);
    $this->getJson("/api/v1/rooms/{$roomId}/pins", $headers)->assertStatus(410);
    $this->postJson("/api/v1/rooms/{$roomId}/typing", ['typing' => true], $headers)->assertStatus(410);
    $this->putJson("/api/v1/rooms/{$roomId}/notifications", ['mode' => 'all'], $headers)->assertStatus(404);

    // message-level paths (edit/delete resolve the room through membership)
    $message = Message::query()->where('room_id', $roomId)->whereNull('deleted_at')->first();
    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'edit'], $headers)->assertStatus(410);
    $this->deleteJson("/api/v1/messages/{$message->id}", [], $headers)->assertStatus(410);
});

test('TC-ROOM-073b expired secret group denies management endpoints too', function () {
    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');
    $room = makeSecretRoom($this->ws, $this->tony, [$this->somchai]);

    $this->travelTo($room->secret_expires_at);

    $this->patchJson("/api/v1/rooms/{$room->id}", ['name' => 'nope'], $headers)
        ->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
    $this->postJson("/api/v1/rooms/{$room->id}/leave", [], $headers)->assertStatus(410);
    $this->deleteJson("/api/v1/rooms/{$room->id}/members/{$this->somchai->id}", [], $headers)->assertStatus(410);
    $this->patchJson("/api/v1/rooms/{$room->id}/members/{$this->somchai->id}", ['role' => 'admin'], $headers)->assertStatus(410);
    $this->deleteJson("/api/v1/rooms/{$room->id}", [], $headers)->assertStatus(410);
});

test('TC-ROOM-073c non-members are denied a live secret room exactly like an ordinary one', function () {
    [$anna, $annaToken] = loginAs($this->anna);
    $room = makeSecretRoom($this->ws, $this->tony, [$this->somchai]);

    $this->getJson("/api/v1/rooms/{$room->id}", wsHeaders($annaToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');
});

// ---------------------------------------------------------------------------
// Realtime + calls + search + unread at expiry
// ---------------------------------------------------------------------------

test('TC-ROOM-074 expired secret room denies the realtime channel and calls', function () {
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880']);
    Http::fake(fn () => Http::response([], 200));

    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $room = makeSecretRoom($this->ws, $this->tony, [$this->somchai]);

    // before expiry both authorize/start
    $this->postJson('/api/v1/broadcasting/auth', ['socket_id' => '1234.5678', 'channel_name' => "private-room.{$room->id}"], authHeaders($token))
        ->assertStatus(200);
    $this->postJson("/api/v1/rooms/{$room->id}/calls", ['kind' => 'video'], wsHeaders($token, 'acme'))->assertStatus(200);

    $this->travelTo($room->secret_expires_at);

    $this->postJson('/api/v1/broadcasting/auth', ['socket_id' => '1234.5678', 'channel_name' => "private-room.{$room->id}"], authHeaders($token))
        ->assertStatus(403);
    $this->postJson("/api/v1/rooms/{$room->id}/calls", ['kind' => 'video'], wsHeaders($token, 'acme'))
        ->assertStatus(404);
});

test('TC-ROOM-075 expired secret room disappears from search, room list and unread counts', function () {
    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');

    $secret = makeSecretRoom($this->ws, $this->tony, [$this->somchai], 2);
    $ordinary = makeOrdinaryRoom($this->ws, $this->tony, [$this->somchai]);

    seedMessage($secret, $this->tony, 'findme-secret');
    seedMessage($ordinary, $this->tony, 'findme-ordinary');

    $this->travelTo($secret->secret_expires_at);

    $this->getJson('/api/v1/search/messages?q=findme', $headers)->assertOk()
        ->tap(function ($response) {
            $bodies = collect($response->json('data.results'))->pluck('message.body')->all();
            expect($bodies)->toContain('findme-ordinary')->not->toContain('findme-secret');
        });

    $roomIds = collect($this->getJson('/api/v1/rooms', $headers)->json('data'))->pluck('room.id')->all();
    expect($roomIds)->toContain($ordinary->id)->not->toContain($secret->id);

    // only the ordinary room's unread message counts (seedMessage leaves
    // last_read_seq at 0, so a live room would show 1)
    $summary = $this->getJson('/api/v1/me/workspaces', authHeaders($token))->json('data');
    $wsSummary = collect($summary)->firstWhere('workspace.slug', 'acme');
    expect($wsSummary['total_unread'])->toBe(1);
});

// ---------------------------------------------------------------------------
// Media: presigned URL TTL capping + denial after expiry
// ---------------------------------------------------------------------------

test('TC-ROOM-076 direct attachment URLs stop resolving after expiry', function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');

    $roomId = $this->postJson('/api/v1/rooms', [
        'type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => 1,
    ], $headers)->assertStatus(201)->json('data.room.id');

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'image', 'filename' => 't.png', 'mime_type' => 'image/png', 'size_bytes' => strlen(secretTinyPng()),
    ], $headers)->assertStatus(201)->json('data');

    $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], secretTinyPng())->assertOk();
    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], $headers)->assertOk();

    $this->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$created['attachment_id']],
    ], $headers)->assertStatus(201);

    $attachmentId = $created['attachment_id'];
    $signed = $this->getJson("/api/v1/attachments/{$attachmentId}", $headers)
        ->assertStatus(200)
        ->json('data.attachment.urls.original');
    expect($signed)->not->toBeNull();

    // before expiry: URL + metadata refresh work
    $this->get($signed)->assertOk();

    $this->travelTo(Room::query()->findOrFail($roomId)->secret_expires_at);

    // after expiry: direct URL 404 (no leak), metadata refresh 410 ROOM_EXPIRED
    $this->get($signed)->assertStatus(404);
    $this->getJson("/api/v1/attachments/{$attachmentId}", $headers)
        ->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
});

test('TC-ROOM-077 presigned URL TTL is capped at the secret deadline once bound', function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    [$user, $token] = loginAs($this->tony);
    $headers = wsHeaders($token, 'acme');

    $secret = makeSecretRoom($this->ws, $this->tony, [$this->somchai], null, 20);
    $secret->forceFill(['secret_expires_at' => now()->addSeconds(37)])->save(); // sub-minute boundary must not round upward
    $ordinary = makeOrdinaryRoom($this->ws, $this->tony, [$this->somchai]);

    $makeBoundAttachment = function (Room $room) use ($headers): array {
        $created = $this->postJson('/api/v1/uploads', [
            'kind' => 'image', 'filename' => 't.png', 'mime_type' => 'image/png', 'size_bytes' => strlen(secretTinyPng()),
        ], $headers)->assertStatus(201)->json('data');
        $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], secretTinyPng())->assertOk();
        $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], $headers)->assertOk();
        $this->postJson("/api/v1/rooms/{$room->id}/messages", [
            'client_message_id' => (string) Str::uuid(), 'attachment_ids' => [$created['attachment_id']],
        ], $headers)->assertStatus(201);

        return $this->getJson("/api/v1/attachments/{$created['attachment_id']}", $headers)
            ->assertStatus(200)->json('data.attachment');
    };

    $secretAttachment = $makeBoundAttachment($secret);
    $ordinaryAttachment = $makeBoundAttachment($ordinary);

    // ordinary: full 60-minute window
    expect(strtotime($ordinaryAttachment['urls_expire_at']))->toBeGreaterThan(now()->addMinutes(58)->getTimestamp());

    // secret-bound: never outlives even a sub-minute deadline
    expect(strtotime($secretAttachment['urls_expire_at']))->toBeLessThanOrEqual($secret->secret_expires_at->getTimestamp())
        ->toBeGreaterThan(now()->getTimestamp());
});

// ---------------------------------------------------------------------------
// Scheduler purge
// ---------------------------------------------------------------------------

test('TC-ROOM-078 scheduler purges room, messages, members, notes; attachments queue for deletion; ordinary rooms survive', function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    Queue::fake();
    Event::fake([RoomDeleted::class]);

    $secret = makeSecretRoom($this->ws, $this->tony, [$this->somchai], 5);
    $ordinary = makeOrdinaryRoom($this->ws, $this->tony, [$this->somchai]);

    $message = seedMessage($secret, $this->tony, 'gone soon');
    $attachment = Attachment::query()->create([
        'workspace_id' => $this->ws->id, 'uploader_id' => $this->tony->id, 'kind' => 'file',
        'status' => 'ready', 'original_name' => 'a.txt', 'mime_type' => 'text/plain',
        'size_bytes' => 3, 'storage_key' => 'secret/a.txt', 'expires_at' => now()->addHour(),
    ]);
    DB::table('message_attachments')->insert(['message_id' => $message->id, 'attachment_id' => $attachment->id]);

    $this->travelTo($secret->secret_expires_at);

    app(ExpireSecretRooms::class)->handle();

    expect(Room::withoutGlobalScopes()->find($secret->id))->toBeNull()
        ->and(Message::query()->where('room_id', $secret->id)->count())->toBe(0)
        ->and(RoomMember::query()->where('room_id', $secret->id)->count())->toBe(0)
        ->and(Room::withoutGlobalScopes()->find($ordinary->id))->not->toBeNull()
        ->and(Attachment::withoutGlobalScopes()->find($attachment->id)->deleted_at)->not->toBeNull();

    // scalar snapshot survives the hard delete — no model rehydration needed
    Event::assertDispatched(RoomDeleted::class, fn (RoomDeleted $e) => $e->roomId === $secret->id
        && collect($e->memberIds)->sort()->values()->all() === collect([$this->tony->id, $this->somchai->id])->sort()->values()->all());
    Queue::assertPushed(PurgeAttachmentFiles::class, fn (PurgeAttachmentFiles $job) => $job->attachmentIds === [$attachment->id]);
    expect(AuditLog::query()->where('action', 'room.secret_expired')->where('target_id', $secret->id)->exists())->toBeTrue();

    // idempotent: a second sweep finds nothing and stays quiet
    Event::fake([RoomDeleted::class]);
    app(ExpireSecretRooms::class)->handle();
    Event::assertNotDispatched(RoomDeleted::class);
});

test('TC-ROOM-079 a soft-deleted secret room is still swept at its secret deadline', function () {
    Queue::fake();
    Event::fake([RoomDeleted::class]);

    $secret = makeSecretRoom($this->ws, $this->tony, [$this->somchai], 5);
    seedMessage($secret, $this->tony, 'moderated but still secret');

    // admin moderation soft-deletes it with the usual 30-day recovery window
    $secret->forceFill(['deleted_at' => now(), 'purge_after' => now()->addDays(30)])->save();

    $this->travelTo($secret->secret_expires_at);
    app(ExpireSecretRooms::class)->handle();

    expect(Room::withoutGlobalScopes()->find($secret->id))->toBeNull()
        ->and(Message::query()->where('room_id', $secret->id)->count())->toBe(0);

    // members already received EVT-003 when the room was moderated — the
    // sweep must not re-announce
    Event::assertNotDispatched(RoomDeleted::class);
});

test('TC-ROOM-080 expiry ends an active call; an SFU outage does not block the purge', function () {
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880']);
    // every LiveKit request fails 503 — DB revocation must still win
    Http::fake(fn () => Http::response([], 503));
    Event::fake([CallChanged::class]);

    $secret = makeSecretRoom($this->ws, $this->tony, [$this->somchai]);
    RoomCall::query()->create([
        'room_id' => $secret->id, 'workspace_id' => $this->ws->id, 'started_by' => $this->tony->id, 'kind' => 'video',
    ]);

    $this->travelTo($secret->secret_expires_at);
    app(ExpireSecretRooms::class)->handle();

    // CallService::end ran to its persist-then-SFU tail (revocation first),
    // the SFU 503 was contained, and the purge still removed the room —
    // the room_calls row cascades away with the room by design
    Event::assertDispatched(CallChanged::class);
    Http::assertSent(fn ($request) => str_contains($request->url(), 'DeleteRoom'));
    expect(Room::withoutGlobalScopes()->find($secret->id))->toBeNull();
});

test('TC-ROOM-081 a fresh secret DM can be created after the previous one expired', function () {
    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');

    $first = $this->postJson('/api/v1/rooms', [
        'type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => 1,
    ], $headers)->assertStatus(201)->json('data.room.id');

    $this->travelTo(now()->addDays(2));

    // row still exists (scheduler lag) but access denies — creation must
    // reclaim the namespaced dm_key and hand back a brand-new room
    $second = $this->postJson('/api/v1/rooms', [
        'type' => 'dm', 'user_id' => $this->somchai->id, 'secret' => true, 'expiry_days' => 5,
    ], $headers)->assertStatus(201)->json('data.room.id');

    expect($second)->not->toBe($first)
        ->and(Room::withoutGlobalScopes()->find($first))->toBeNull();

    $this->postJson("/api/v1/rooms/{$second}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => 'fresh start'], $headers)
        ->assertStatus(201);
});

test('TC-ROOM-082 ordinary rooms are bit-for-bit unaffected — no secret columns leak into responses', function () {
    [$user, $token] = loginAs($this->tony);
    extendTokens($this->tony);
    $headers = wsHeaders($token, 'acme');

    $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->somchai->id], $headers)->assertStatus(201);
    $this->postJson('/api/v1/rooms', ['type' => 'group', 'name' => 'Plain', 'member_ids' => [$this->somchai->id]], $headers)->assertStatus(201);

    collect($this->getJson('/api/v1/rooms', $headers)->json('data'))->each(function ($item) {
        expect($item['room']['is_secret'])->toBeFalse()
            ->and($item['room']['secret_expires_at'])->toBeNull();
    });

    $this->travelTo(now()->addYears(2));

    // years later the ordinary rooms still work end to end
    $roomId = Room::query()->where('name', 'Plain')->value('id');
    $this->getJson("/api/v1/rooms/{$roomId}/messages", $headers)->assertStatus(200);
    $this->postJson("/api/v1/rooms/{$roomId}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => 'still here'], $headers)
        ->assertStatus(201);
});
