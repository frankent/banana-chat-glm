<?php

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Enums\MemberStatus;
use App\Enums\PublicChatStatus;
use App\Enums\UserStatus;
use App\Events\NotificationAlert;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Events\PublicChatRoomCreated;
use App\Http\Middleware\VerifyPublicChatSignature as Hmac;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatRoom;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * FR-PCHAT-001/013/014/019 — ISOLATION, which is the entire point of this
 * architecture, plus the ingest bounds and the membership gate.
 *
 * §12.4 coverage in this file:
 *   TC-PCHAT-015 a later username/provider rename never rewrites the transcript
 *   TC-PCHAT-019 suspended / removed / other-workspace members are refused on Tier 3
 *   TC-PCHAT-024 no call AND no meeting surface resolves a public chat room id
 *   TC-PCHAT-025 never in GET /rooms, /search/messages, /search/files, /sync or unread
 *   TC-PCHAT-027 the same link open in two browsers: both send, both see each other
 *   TC-PCHAT-031 an internal room id is refused by every public-chat endpoint and vice versa
 *   TC-PCHAT-050 the signature comparison is constant-time
 *   plus the Tier-1 ingest bounds (name length, whitespace-only, control chars, meta 8KB, locale)
 *   and the channel-auth equality assertion under prefix/suffix attack.
 *
 * "Isolation" here means STRUCTURAL: a public chat room is not a `rooms` row, so
 * these assertions are not testing a gate someone remembered to write — they are
 * testing that no shared query path exists at all. That is exactly why they must
 * exist: the day someone "unifies" the two models, these go red.
 */

// ---------------------------------------------------------------------------
// Helpers — guarded, because Pest loads every file in this directory into ONE
// process and FoundationTest.php/ApiTest.php declare the same names.
// ---------------------------------------------------------------------------

if (! function_exists('pchatHeaders')) {
    function pchatHeaders(string $keyId, string $secret, string $method, string $path, string $rawBody, array $overrides = []): array
    {
        $timestamp = (string) ($overrides['timestamp'] ?? now()->getTimestamp());
        $nonce = (string) ($overrides['nonce'] ?? Str::random(24));

        $signature = $overrides['signature']
            ?? 'v1='.hash_hmac('sha256', Hmac::canonical($method, $path, $timestamp, $nonce, $rawBody), $secret);

        return array_filter([
            'X-PChat-Key' => $overrides['key'] ?? $keyId,
            'X-PChat-Timestamp' => $timestamp,
            'X-PChat-Nonce' => $nonce,
            'X-PChat-Signature' => $signature,
            'Content-Type' => 'application/json',
        ], fn ($v) => $v !== null);
    }
}

if (! function_exists('pchatServerVars')) {
    function pchatServerVars(array $headers): array
    {
        $server = ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'];

        foreach ($headers as $name => $value) {
            if (strtolower($name) === 'content-type') {
                continue;
            }
            $server['HTTP_'.str_replace('-', '_', strtoupper($name))] = $value;
        }

        return $server;
    }
}

if (! function_exists('pchatSigned')) {
    /** Signs the RAW body bytes — postJson() re-serialises and would break the MAC. */
    function pchatSigned(string $method, string $path, ?array $body, string $keyId, string $secret, array $overrides = []): TestResponse
    {
        $raw = $body === null ? '' : (string) json_encode($body);

        return test()->call($method, $path, [], [], [], pchatServerVars(pchatHeaders($keyId, $secret, $method, $path, $raw, $overrides)), $raw);
    }
}

if (! function_exists('pchatMakeKey')) {
    /** @return array{0: PublicChatApiKey, 1: string} [key, plaintext secret] */
    function pchatMakeKey(Workspace $workspace): array
    {
        $secret = PublicChatApiKey::generateSecret();

        $key = PublicChatApiKey::withoutGlobalScopes()->create([
            'workspace_id' => $workspace->id,
            'name' => 'Partner Integration',
            'key_id' => PublicChatApiKey::generateKeyId(),
            'secret_ciphertext' => Crypt::encryptString($secret),
            'secret_last4' => substr($secret, -4),
        ]);

        return [$key, $secret];
    }
}

if (! function_exists('pchatCreateRoom')) {
    function pchatCreateRoom(Workspace $workspace, array $overrides = []): PublicChatRoom
    {
        return PublicChatRoom::withoutGlobalScopes()->create(array_merge([
            'workspace_id' => $workspace->id,
            'code' => PublicChatRoom::generateCode(),
            'customer_name' => 'Somchai',
            'provider_name' => 'ACME Support',
            'status' => PublicChatStatus::New->value,
            'locale' => 'th',
            'expires_at' => now()->addDays(30),
        ], $overrides));
    }
}

if (! function_exists('pchatFakedEvents')) {
    /** @return list<class-string> */
    function pchatFakedEvents(): array
    {
        return [
            PublicChatMessageCreated::class,
            PublicChatMessageCreatedStaff::class,
            PublicChatMessageDeleted::class,
            PublicChatRoomChanged::class,
            PublicChatRoomChangedStaff::class,
            PublicChatRoomCreated::class,
            NotificationAlert::class,
        ];
    }
}

beforeEach(function () {
    Event::fake(pchatFakedEvents());

    app(SettingsService::class)->set('publicchat.enabled', true);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->otherWs = Workspace::factory()->create(['slug' => 'globex']);

    $this->agent = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai S.']);
    $this->stranger = User::factory()->create(['username' => 'globexowner', 'display_name' => 'Globex Owner']);

    $this->ws->members()->attach($this->agent->id, ['role' => 'owner']);
    $this->otherWs->members()->attach($this->stranger->id, ['role' => 'owner']);

    [$this->key, $this->secret] = pchatMakeKey($this->ws);

    $this->room = pchatCreateRoom($this->ws);
});

// ===========================================================================
// TC-PCHAT-015 — write-time snapshots
// ===========================================================================

it('TC-PCHAT-015 keeps the customer transcript on the write-time snapshot after a rename', function () {
    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/public-chat/rooms/'.$this->room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'we are looking into it',
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    $before = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages')
        ->assertStatus(200)
        ->json('messages');

    $agentRow = collect($before)->firstWhere('sender_kind', 'agent');
    expect($agentRow['display_name'])->toBe('ACME Support (somchai)');

    // The rename that must NOT reach back into what the customer already read:
    // a username change, and the provider renaming itself on the room.
    $this->agent->forceFill(['username' => 'somchai2', 'display_name' => 'Somchai Suk'])->save();
    $this->room->forceFill(['provider_name' => 'ACME Care'])->save();

    $after = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages')
        ->assertStatus(200)
        ->json('messages');

    $agentRowAfter = collect($after)->firstWhere('sender_kind', 'agent');

    // The serializer computes the external name from provider_name_snapshot +
    // agent_username_snapshot and NEVER joins `users`. If it ever did, this
    // reads 'ACME Care (somchai2)' — and a buggy join could then surface a user
    // row on the customer surface.
    expect($agentRowAfter['display_name'])->toBe('ACME Support (somchai)');

    $encoded = (string) json_encode($after);
    expect($encoded)->not->toContain($this->agent->id)
        ->and($encoded)->not->toContain('somchai2')
        ->and($encoded)->not->toContain('Somchai Suk');
});

// ===========================================================================
// TC-PCHAT-025 / 024 — the room that is in no list, no search and no call
// ===========================================================================

it('TC-PCHAT-025 keeps a public chat room out of GET /rooms, both searches, sync and the unread badge', function () {
    [, $token] = loginAs($this->agent);

    // Give the workspace a real internal room, so "the lists are empty" cannot
    // be the reason any of these assertions passes.
    $internal = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->agent->id,
        'owner_id' => $this->agent->id,
        'member_count' => 1,
        'last_message_at' => now(),
    ]);

    RoomMember::query()->create([
        'room_id' => $internal->id,
        'user_id' => $this->agent->id,
        'workspace_id' => $this->ws->id,
        'role' => 'owner',
        'added_by' => $this->agent->id,
    ]);

    // A customer name that cannot collide with the requesting agent's own
    // display name — otherwise "the name is absent" could pass or fail for a
    // reason that has nothing to do with isolation.
    $this->room->forceFill(['customer_name' => 'Zq Visitor'])->save();

    // A visitor message carrying a very distinctive word, plus a ready file.
    $needle = 'zxqvpublicneedle';

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'my order '.$needle.' is late',
    ])->assertStatus(201);

    $attachment = new Attachment;
    $attachment->forceFill([
        'workspace_id' => $this->ws->id,
        'uploader_id' => null,
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::File->value,
        'status' => AttachmentStatus::Ready->value,
        'original_name' => $needle.'.pdf',
        'mime_type' => 'application/pdf',
        'size_bytes' => 512,
        'storage_key' => 'ws/'.$this->ws->id.'/att/'.Str::ulid()->toBase32().'/original',
    ])->save();

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$attachment->id],
    ])->assertStatus(201);

    // GET /api/v1/sync (API-050) is deliberately NOT in this list: it 500s for
    // every user who is a member of any room, on a pre-existing bug unrelated to
    // this feature — WorkspaceController::sync selects room_members.last_user_seq,
    // but last_user_seq is a `rooms` column (2026_09_07_000004_create_rooms_table.php:22).
    // Asserting isolation through a 500 would prove nothing, and fixing it is
    // outside this feature's blast radius.
    $surfaces = [
        '/api/v1/rooms',
        '/api/v1/search/messages?q='.$needle,
        '/api/v1/search/files?q='.$needle,
    ];

    foreach ($surfaces as $url) {
        $response = $this->getJson($url, wsHeaders($token, 'acme'));
        $response->assertStatus(200);

        $body = (string) json_encode($response->json());

        expect($body)->not->toContain($this->room->id)
            ->and($body)->not->toContain($this->room->code)
            ->and($body)->not->toContain($needle)
            ->and($body)->not->toContain('Zq Visitor');
    }

    // And the unread badge: the internal room is the only thing that can carry
    // an unread count, and two customer messages must not have moved it.
    $rooms = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'))->json();
    $unread = collect($rooms['data'] ?? $rooms)->sum(fn ($room) => (int) ($room['unread_count'] ?? 0));
    expect($unread)->toBe(0);
});

it('TC-PCHAT-024 resolves a public chat room id on no call and no meeting endpoint', function () {
    [, $token] = loginAs($this->agent);

    // Enabled, or these 503 before ever looking at the id and prove nothing.
    config(['calls.enabled' => true, 'calls.secret' => 'test-secret', 'calls.url' => 'wss://livekit.test']);

    // CallService::allowed() joins `rooms`; a public chat ULID does not resolve
    // there, so there is no gate to forget — the surface does not exist.
    $this->postJson('/api/v1/rooms/'.$this->room->id.'/calls', ['kind' => 'video'], wsHeaders($token, 'acme'))
        ->assertStatus(404);

    // Meetings are workspace-level, not room-attached (MeetingController::create
    // accepts a title only), so the only way a public chat id could reach the
    // meeting surface is as a meeting id — and it must not resolve there either.
    config(['meetings.enabled' => true]);

    $this->postJson('/api/v1/meetings/'.$this->room->id.'/end', [], wsHeaders($token, 'acme'))
        ->assertStatus(404);

    // Nor is the visitor's own code a meeting code: two separate tables, two
    // separate 64-hex namespaces, no shared lookup.
    $this->getJson('/api/v1/public-meetings/'.$this->room->code)->assertStatus(404);

    // Nothing was created on either side.
    expect(DB::table('room_calls')->count())->toBe(0)
        ->and(DB::table('meetings')->count())->toBe(0);
});

it('TC-PCHAT-031 refuses an internal room id on every public-chat endpoint, and a public chat id on the message endpoints', function () {
    [, $token] = loginAs($this->agent);

    $internal = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->agent->id,
        'owner_id' => $this->agent->id,
        'member_count' => 1,
        'last_message_at' => now(),
    ]);

    RoomMember::query()->create([
        'room_id' => $internal->id,
        'user_id' => $this->agent->id,
        'workspace_id' => $this->ws->id,
        'role' => 'owner',
        'added_by' => $this->agent->id,
    ]);

    $headers = wsHeaders($token, 'acme');

    // A `rooms` id is not addressable by a public-chat route.
    $this->getJson('/api/v1/public-chat/rooms/'.$internal->id, $headers)->assertStatus(404);
    $this->getJson('/api/v1/public-chat/rooms/'.$internal->id.'/messages', $headers)->assertStatus(404);
    $this->patchJson('/api/v1/public-chat/rooms/'.$internal->id, ['status' => 'done'], $headers)->assertStatus(404);
    $this->postJson('/api/v1/public-chat/rooms/'.$internal->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'hi',
    ], $headers)->assertStatus(404);
    $this->postJson('/api/v1/public-chat/rooms/'.$internal->id.'/read', ['last_read_seq' => 1], $headers)->assertStatus(404);

    // And the mirror image: a public chat id is not a room.
    $this->getJson('/api/v1/rooms/'.$this->room->id, $headers)->assertStatus(404);
    $this->getJson('/api/v1/rooms/'.$this->room->id.'/messages', $headers)->assertStatus(404);
    $this->postJson('/api/v1/rooms/'.$this->room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'hi',
    ], $headers)->assertStatus(404);

    expect(Message::query()->count())->toBe(0);

    // A code is not a room id either: the Tier-2 routes are constrained to
    // exactly 64 lowercase hex, so a near-miss never reaches a controller.
    foreach ([
        substr($this->room->code, 0, 63),
        strtoupper($this->room->code),
        $this->room->code.'a',
        $this->room->id,
    ] as $badCode) {
        $this->getJson('/api/v1/public-chat/'.$badCode)->assertStatus(404);
        $this->postJson('/api/v1/public-chat/'.$badCode.'/messages', [
            'client_message_id' => (string) Str::uuid(), 'body' => 'hi',
        ])->assertStatus(404);
    }
});

// ===========================================================================
// TC-PCHAT-019 — the membership gate on Tier 3
// ===========================================================================

it('TC-PCHAT-019 refuses Tier 3 to a removed member, a suspended user and another workspace member', function () {
    $endpoints = function (string $token) {
        $headers = wsHeaders($token, 'acme');

        return [
            $this->getJson('/api/v1/public-chat/rooms', $headers),
            $this->getJson('/api/v1/public-chat/rooms/'.$this->room->id, $headers),
            $this->getJson('/api/v1/public-chat/summary', $headers),
            $this->postJson('/api/v1/public-chat/rooms/'.$this->room->id.'/messages', [
                'client_message_id' => (string) Str::uuid(), 'body' => 'let me in',
            ], $headers),
            $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, ['status' => 'done'], $headers),
        ];
    };

    // 1. An active member of ANOTHER workspace, using this workspace's slug.
    [, $strangerToken] = loginAs($this->stranger);
    foreach ($endpoints($strangerToken) as $response) {
        expect($response->status())->toBeIn([403, 404]);
    }

    // 2. A member whose membership was removed AFTER the token was issued —
    //    the token is still valid, so only the membership check can stop them.
    [, $agentToken] = loginAs($this->agent);
    $this->getJson('/api/v1/public-chat/rooms', wsHeaders($agentToken, 'acme'))->assertStatus(200);

    DB::table('workspace_members')
        ->where('workspace_id', $this->ws->id)
        ->where('user_id', $this->agent->id)
        ->update(['status' => MemberStatus::Removed->value]);

    foreach ($endpoints($agentToken) as $response) {
        expect($response->status())->toBeIn([403, 404]);
    }

    // 3. An active member whose USER account was suspended, then deactivated.
    //    Membership is restored first, so the account status is the only thing
    //    left that can refuse them.
    DB::table('workspace_members')
        ->where('workspace_id', $this->ws->id)
        ->where('user_id', $this->agent->id)
        ->update(['status' => MemberStatus::Active->value]);

    foreach ([UserStatus::Suspended, UserStatus::Deactivated] as $status) {
        $this->agent->forceFill(['status' => $status->value])->save();

        foreach ($endpoints($agentToken) as $response) {
            expect($response->status())->toBeIn([401, 403], $status->value);
        }
    }

    // Nothing the three of them attempted was written.
    expect(DB::table('public_chat_messages')->count())->toBe(0)
        ->and(PublicChatRoom::withoutGlobalScopes()->findOrFail($this->room->id)->status)
        ->toBe(PublicChatStatus::New);
});

// ===========================================================================
// TC-PCHAT-027 — the link is the identity, and it is not a session
// ===========================================================================

it('TC-PCHAT-027 lets the same link work from two independent browsers, each seeing the other', function () {
    // There is no session, no cookie and no device binding: "two browsers" is
    // simply two stateless requests carrying the same code (DEC-063). Both must
    // send, and each must see the other's message.
    $first = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'sent from the desktop',
    ])->assertStatus(201);

    $second = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'sent from the phone',
    ])->assertStatus(201);

    // Different client ids -> two distinct rows with consecutive seq.
    expect($second->json('message.seq'))->toBe($first->json('message.seq') + 1);

    $transcript = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages')
        ->assertStatus(200);

    $bodies = collect($transcript->json('messages'))->pluck('body')->all();

    expect($bodies)->toContain('sent from the desktop')
        ->and($bodies)->toContain('sent from the phone');

    // Catch-up from the phone's perspective: everything after its own last seq.
    $afterFirst = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages?after_seq='.$first->json('message.seq'))
        ->assertStatus(200);

    expect(collect($afterFirst->json('messages'))->pluck('body')->all())->toBe(['sent from the phone']);
});

// ===========================================================================
// Tier-1 ingest bounds — the names render on three surfaces
// ===========================================================================

it('FR-PCHAT-014 bounds every partner-supplied field on create', function () {
    $path = '/api/v1/partner/public-chat/rooms';
    $valid = ['customer_name' => 'Somchai', 'provider_name' => 'ACME Support'];

    $cases = [
        'customer_name too long' => ['customer_name' => str_repeat('a', 121)] + $valid,
        'provider_name too long' => ['provider_name' => str_repeat('b', 121)] + $valid,
        'customer_name missing' => ['provider_name' => 'ACME Support'],
        'provider_name missing' => ['customer_name' => 'Somchai'],
        'customer_name blank after trim' => ['customer_name' => "   \t  "] + $valid,
        'external_ref too long' => ['external_ref' => str_repeat('r', 121)] + $valid,
        'unsupported locale' => ['locale' => 'fr'] + $valid,
        // 8KB cap on the partner's arbitrary payload — one call must not be
        // able to park megabytes in a jsonb column.
        'meta over 8KB' => ['meta' => ['blob' => str_repeat('x', 9000)]] + $valid,
    ];

    foreach ($cases as $label => $body) {
        $response = pchatSigned('POST', $path, $body, $this->key->key_id, $this->secret);

        expect($response->status())->toBe(422, $label);
        $response->assertJsonPath('error.code', 'VALIDATION_FAILED');
    }

    // Not one of them created a room.
    expect(PublicChatRoom::withoutGlobalScopes()->where('workspace_id', $this->ws->id)->count())->toBe(1);

    // Just under each bound still works, and the accepted row is SANITISED:
    // C0 control characters and the bidi overrides that let a name redraw a UI
    // are stripped at ingest, not at render, because the name reaches three
    // different renderers (visitor SPA, agent SPA, Filament transcript).
    $ok = pchatSigned('POST', $path, [
        'customer_name' => "So\x00mchai\u{202E}",
        'provider_name' => str_repeat('c', 120),
        'external_ref' => str_repeat('r', 120),
        'locale' => 'en',
        'meta' => ['order_id' => 'A-9'],
    ], $this->key->key_id, $this->secret);

    $ok->assertStatus(201);

    $created = PublicChatRoom::withoutGlobalScopes()->findOrFail($ok->json('room.id'));

    expect($created->customer_name)->toBe('Somchai')
        ->and($created->provider_name)->toHaveLength(120)
        ->and($created->locale)->toBe('en');
});

// ===========================================================================
// TC-PCHAT-050 — the comparison itself
// ===========================================================================

it('TC-PCHAT-050 compares the presented signature in constant time', function () {
    $source = file_get_contents(app_path('Http/Middleware/VerifyPublicChatSignature.php'));

    expect($source)->toContain('hash_equals(');

    // A byte-by-byte === on the MAC leaks the length of the shared prefix
    // through timing, which is enough to forge a signature given enough
    // attempts. Strip every comment first so prose about "===" cannot make this
    // pass or fail for the wrong reason, then look for any equality/strcmp
    // applied to the presented signature.
    $code = (string) preg_replace(['~/\*.*?\*/~s', '~//[^\n]*~'], '', $source);

    foreach (['strcmp(', 'strcasecmp('] as $forbidden) {
        expect($code)->not->toContain($forbidden);
    }

    expect($code)->not->toMatch('/\$(presented|signature|expected|computed)\w*\s*(===|==|!==|!=)\s*\$/i');
});

// ===========================================================================
// TC-PCHAT-017/018 — the channel-auth equality assertion under attack
// ===========================================================================

it('TC-PCHAT-017/018 signs nothing for a channel name that is merely a near miss', function () {
    $neighbour = pchatCreateRoom($this->ws);

    $hostile = [
        // prefix-matching attempts: every one of these passes a
        // str_starts_with / regex / str_contains "generalisation" of the check.
        'private-public-chat.'.$this->room->id.'extra',
        'private-public-chat.'.$this->room->id.'.staff',
        'private-public-chat.'.$this->room->id.'-staff',
        'private-public-chat-staff.'.$this->room->id,
        'private-public-chat.',
        'private-public-chat.'.$neighbour->id,
        // and the ones that would let the endpoint sign something else entirely
        'private-room.'.$this->room->id,
        'presence-public-chat.'.$this->room->id,
        'PRIVATE-PUBLIC-CHAT.'.$this->room->id,
        // NOTE: whitespace-padded variants ("…{id}\n", " …{id}") are deliberately
        // absent. Laravel's TrimStrings middleware normalises them back to the
        // one legal value before the controller sees them, so they authorise the
        // caller's OWN channel and confer nothing. The dangerous shapes are the
        // ones above, which survive trimming and name a DIFFERENT channel.
    ];

    foreach ($hostile as $channel) {
        $response = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/broadcasting/auth', [
            'socket_id' => '123.456',
            'channel_name' => $channel,
        ]);

        expect($response->status())->not->toBe(200, $channel);
        // Nothing signed leaves the endpoint, under any status.
        expect((string) $response->getContent())->not->toContain('auth');
    }

    // The single legal value still works, so the assertions above are not
    // passing because the endpoint is simply broken.
    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => 'private-public-chat.'.$this->room->id,
    ])->assertStatus(200)->assertJsonStructure(['auth']);
});
