<?php

use App\Events\NotificationAlert;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Events\PublicChatRoomCreated;
use App\Models\PublicChatGuest;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;

/**
 * FR-PCHAT-040/041/042 — password group rooms, guest re-entry, room meeting.
 *
 *   TC-PCHAT-060 member creates a group room; link + hashed password
 *   TC-PCHAT-061 wrong password -> 403; support room join -> same 403
 *   TC-PCHAT-062 guest chats; no token -> 401 on reads and writes
 *   TC-PCHAT-063 re-entry by the same name resumes the same guest, old token dies
 *   TC-PCHAT-064 password change revokes every guest token
 *   TC-PCHAT-065 two guests may reuse one client_message_id
 *   TC-PCHAT-066 meeting needs a guest token; none configured -> 404
 */
beforeEach(function () {
    Event::fake([
        PublicChatMessageCreated::class,
        PublicChatMessageCreatedStaff::class,
        PublicChatMessageDeleted::class,
        PublicChatRoomChanged::class,
        PublicChatRoomChangedStaff::class,
        PublicChatRoomCreated::class,
        NotificationAlert::class,
    ]);
    app(SettingsService::class)->set('publicchat.enabled', true);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->member = User::factory()->create();
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);
});

function pchatMakeGroup($test, string $password = 'secret-pw'): array
{
    [, $token] = loginAs($test->member);
    $res = $test->postJson('/api/v1/public-chat/rooms', ['title' => 'Launch', 'password' => $password], wsHeaders($token, 'acme'));
    $res->assertStatus(201);
    $room = PublicChatRoom::withoutGlobalScopes()->findOrFail($res->json('room.id'));

    return [$room, $token, $res];
}

function pchatGuestJoin($test, PublicChatRoom $room, string $name, string $password = 'secret-pw')
{
    return $test->postJson('/api/v1/public-chat/'.$room->code.'/join', ['password' => $password, 'display_name' => $name]);
}

it('TC-PCHAT-060 creates a group room with a hashed password and a share link', function () {
    [$room, , $res] = pchatMakeGroup($this);

    expect($room->kind)->toBe('group')
        ->and($room->password_hash)->not->toBe('secret-pw')
        ->and($res->json('url'))->toContain($room->code)
        ->and($res->json('room'))->not->toHaveKey('password_hash');
});

it('TC-PCHAT-061 refuses a wrong password and does not reveal a support room', function () {
    [$room] = pchatMakeGroup($this);
    pchatGuestJoin($this, $room, 'Ann', 'nope')->assertStatus(403)->assertJsonPath('error.code', 'PCHAT_PASSWORD_INVALID');

    $support = PublicChatRoom::withoutGlobalScopes()->create([
        'workspace_id' => $this->ws->id, 'code' => PublicChatRoom::generateCode(), 'customer_name' => 'X',
        'provider_name' => 'Y', 'status' => 'new', 'locale' => 'en', 'expires_at' => now()->addDay(),
    ]);
    pchatGuestJoin($this, $support, 'Ann')->assertStatus(403)->assertJsonPath('error.code', 'PCHAT_PASSWORD_INVALID');
});

it('TC-PCHAT-062 lets a guest read and write only with a token', function () {
    [$room] = pchatMakeGroup($this);
    $path = '/api/v1/public-chat/'.$room->code;
    $this->getJson($path)->assertStatus(200)->assertJsonPath('requires_password', true);
    $this->getJson($path.'/messages')->assertStatus(401)->assertJsonPath('error.code', 'PCHAT_GUEST_REQUIRED');

    $token = pchatGuestJoin($this, $room, 'Ann')->assertStatus(201)->json('guest_token');
    $h = ['X-PChat-Guest' => $token];
    $this->getJson($path, $h)->assertJsonPath('requires_password', false)->assertJsonPath('viewer.kind', 'guest')->assertJsonPath('can_send', true);
    $this->postJson($path.'/messages', ['client_message_id' => (string) Str::uuid(), 'body' => 'hi'], $h)->assertStatus(201);
    $this->postJson($path.'/messages', ['client_message_id' => (string) Str::uuid(), 'body' => 'hi'])->assertStatus(401);
});

it('TC-PCHAT-063 resumes the same guest on re-entry and kills the old token', function () {
    [$room] = pchatMakeGroup($this);
    $a = pchatGuestJoin($this, $room, 'Ann')->json();
    $b = pchatGuestJoin($this, $room, 'ann')->json();

    expect($b['guest']['id'])->toBe($a['guest']['id'])
        ->and($b['guest_token'])->not->toBe($a['guest_token'])
        ->and(PublicChatGuest::where('room_id', $room->id)->count())->toBe(1);

    $this->getJson('/api/v1/public-chat/'.$room->code.'/messages', ['X-PChat-Guest' => $a['guest_token']])->assertStatus(401);
    $this->getJson('/api/v1/public-chat/'.$room->code.'/messages', ['X-PChat-Guest' => $b['guest_token']])->assertStatus(200);
});

it('TC-PCHAT-064 revokes every guest when the password changes', function () {
    [$room, $token] = pchatMakeGroup($this);
    $guest = pchatGuestJoin($this, $room, 'Ann')->json('guest_token');

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/password', ['password' => 'brand-new-pw'], wsHeaders($token, 'acme'))->assertStatus(200);

    $this->getJson('/api/v1/public-chat/'.$room->code.'/messages', ['X-PChat-Guest' => $guest])->assertStatus(401);
    pchatGuestJoin($this, $room, 'Ann')->assertStatus(403);
    pchatGuestJoin($this, $room, 'Ann', 'brand-new-pw')->assertStatus(201);
});

it('TC-PCHAT-065 keeps client_message_id idempotency per guest', function () {
    [$room] = pchatMakeGroup($this);
    $ta = pchatGuestJoin($this, $room, 'Ann')->json('guest_token');
    $tb = pchatGuestJoin($this, $room, 'Bob')->json('guest_token');
    $id = (string) Str::uuid();
    $path = '/api/v1/public-chat/'.$room->code.'/messages';

    $this->postJson($path, ['client_message_id' => $id, 'body' => 'a'], ['X-PChat-Guest' => $ta])->assertStatus(201);
    $second = $this->postJson($path, ['client_message_id' => $id, 'body' => 'b'], ['X-PChat-Guest' => $tb]);
    $second->assertStatus(201)->assertJsonPath('message.body', 'b');
});

it('TC-PCHAT-066 gates the room meeting behind a guest token', function () {
    [$room, $token] = pchatMakeGroup($this);
    $path = '/api/v1/public-chat/'.$room->code.'/meeting/join';

    $this->postJson($path)->assertStatus(401);
    $guest = pchatGuestJoin($this, $room, 'Ann')->json('guest_token');
    $this->postJson($path, [], ['X-PChat-Guest' => $guest])->assertStatus(404); // no meeting on this room
    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/meeting/join', [], wsHeaders($token, 'acme'))->assertStatus(404);
});
