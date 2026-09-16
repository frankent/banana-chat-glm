<?php

use App\Domain\PublicChat\NotifyPublicChatMessage;
use App\Domain\PublicChat\PublicChatApiKeyService;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Events\NotificationAlert;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Events\PublicChatRoomCreated;
use App\Http\Middleware\VerifyPublicChatSignature as Hmac;
use App\Models\AuditLog;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRead;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * FR-PCHAT-001..016/020/030..034 — the three API tiers, the realtime channels
 * and the queue semantics.
 *
 * §12.4 coverage in this file:
 *   TC-PCHAT-001 HMAC happy path returns a /support/<64hex> link
 *   TC-PCHAT-006 same external_ref twice -> 200, same code, one row
 *   TC-PCHAT-008 valid signature + feature off -> 503, not 401
 *   TC-PCHAT-009 visitor sends twice with one client_message_id -> one row
 *   TC-PCHAT-010 two agent replies -> exactly one claim, one system row, gapless seq
 *   TC-PCHAT-011 auto-claim sets status/assigned_to/claimed_at and emits EVT-081
 *   TC-PCHAT-012 reassignment and every status transition persist
 *   TC-PCHAT-013 agent renders externally as "Provider (username)", internally as the user
 *   TC-PCHAT-014 public payload minimality
 *   TC-PCHAT-016/017/018 visitor channel auth: own channel, another room, the staff channel
 *   TC-PCHAT-019 active member authorises both channels; other-workspace member refused
 *   TC-PCHAT-024/025 no call surface, never in GET /rooms
 *   TC-PCHAT-026 feature off: writes 503, visitor GET 200 can_send:false
 *   TC-PCHAT-028 after done: visitor GET 200 read-only, POST 409, reopen -> 201
 *   TC-PCHAT-029 after expires_at every Tier-2 route incl. broadcasting/auth -> 410
 *   TC-PCHAT-031 a room is unreachable with another workspace's X-Workspace-Id
 *   TC-PCHAT-032 status_public never leaks `problem`
 *   TC-PCHAT-033 q matches message body
 *   TC-PCHAT-034 push assigned-only / nobody when unassigned
 *   TC-PCHAT-035 reply_to snippet without sender identity
 *   TC-PCHAT-036 rotate-link
 *   TC-PCHAT-040 partner addresses rooms by ULID; a 64-hex {id} is a 404
 *   TC-PCHAT-041 visitor cannot squat an agent client id; non-UUID -> 422
 *   TC-PCHAT-042 read pointer is monotonic
 *   TC-PCHAT-044/045 member bearer read-200/write-403; invalid bearer 401
 *   TC-PCHAT-046 queue sort order
 *   TC-PCHAT-047 first_response_at
 *   TC-PCHAT-048 the plaintext secret never reaches audit_logs
 *   TC-PCHAT-049 named limiters are keyed per code, not per IP
 */

// ---------------------------------------------------------------------------
// Helpers. Pest loads EVERY test file into ONE process, so each of these is
// guarded — FoundationTest.php already defines pchatHeaders()/PROBE_PATH and a
// redeclaration is a FATAL, not a warning. Reuse, never redefine.
// ---------------------------------------------------------------------------

if (! function_exists('pchatHeaders')) {
    /**
     * Mirror of FoundationTest.php's helper, guarded so EITHER file can run
     * alone (Pest loads every file into one process, so the first declaration
     * wins and a second would be a fatal). It cannot drift in the way that
     * matters: the canonical string itself has exactly ONE definition,
     * Hmac::canonical(), and both copies call it.
     */
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

if (! function_exists('pchatSigned')) {
    /**
     * Signs an arbitrary partner request over the RAW body bytes.
     *
     * $this->postJson() CANNOT be used: it re-serialises the payload, and the
     * signature covers the exact bytes on the wire. Everything goes through
     * ->call(..., $rawBody) for that reason — which is also the single most
     * common integration bug this API's docs must warn about.
     */
    function pchatSigned(string $method, string $path, ?array $body, string $keyId, string $secret, array $overrides = []): TestResponse
    {
        $raw = $body === null ? '' : (string) json_encode($body);

        return test()->call($method, $path, [], [], [], pchatServerVars(pchatHeaders($keyId, $secret, $method, $path, $raw, $overrides)), $raw);
    }
}

if (! function_exists('pchatServerVars')) {
    /**
     * CONTENT_TYPE is passed as a RAW server var, not as HTTP_CONTENT_TYPE.
     * Symfony's Request::create() forces CONTENT_TYPE to
     * application/x-www-form-urlencoded for a POST when only the HTTP_ form is
     * present, and the body then never reaches the JSON parser — every field
     * comes back "required". A real partner sends a real Content-Type header;
     * this is a test-harness artefact, not an API quirk.
     */
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
    /** Direct-model fixture; the HMAC create path is exercised on its own. */
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
    /**
     * Every public-chat broadcast plus NotificationAlert. BROADCAST_CONNECTION is
     * `reverb` in phpunit.xml, so anything left un-faked tries to reach a live
     * Reverb — and Event::fake() REPLACES the dispatcher, so a later partial
     * re-fake would quietly let the rest through. Always fake the whole set.
     *
     * @return list<class-string>
     */
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

    // DEC-071 ships the feature OFF. Every test that exercises a WRITE turns it
    // on explicitly; the two feature-off tests turn it back off.
    app(SettingsService::class)->set('publicchat.enabled', true);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->otherWs = Workspace::factory()->create(['slug' => 'globex']);

    $this->agent = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai S.']);
    $this->agent2 = User::factory()->create(['username' => 'anna', 'display_name' => 'Anna A.']);
    $this->outsider = User::factory()->create(['username' => 'globexowner']);

    $this->ws->members()->attach($this->agent->id, ['role' => 'member']);
    $this->ws->members()->attach($this->agent2->id, ['role' => 'admin']);
    $this->otherWs->members()->attach($this->outsider->id, ['role' => 'owner']);

    [$this->key, $this->secret] = pchatMakeKey($this->ws);
});

// ===========================================================================
// TIER 1 — partner, HMAC (API-200..203)
// ===========================================================================

it('TC-PCHAT-001 creates a room over HMAC and returns a /support/<64hex> link', function () {
    $path = '/api/v1/partner/public-chat/rooms';

    $response = pchatSigned('POST', $path, [
        'customer_name' => 'คุณสมชาย',
        'provider_name' => 'ACME Support',
        'external_ref' => 'TICKET-1',
        'locale' => 'th',
        'meta' => ['order_id' => 'A-9'],
    ], $this->key->key_id, $this->secret);

    $response->assertStatus(201)
        ->assertJsonPath('room.status', 'new')
        ->assertJsonPath('room.customer_name', 'คุณสมชาย');

    // The partner gets the room ULID (every later partner call uses it) and the
    // visitor URL. The code lives in the PATH, never in a query string.
    expect($response->json('room.id'))->toBeString()
        ->and($response->json('url'))->toMatch('#/support/[a-f0-9]{64}$#');

    $room = PublicChatRoom::withoutGlobalScopes()->firstOrFail();
    expect($room->workspace_id)->toBe($this->ws->id)
        ->and($room->api_key_id)->toBe($this->key->id)
        ->and($room->expires_at)->not->toBeNull();

    Event::assertDispatched(PublicChatRoomCreated::class);
});

it('TC-PCHAT-006 replays the same external_ref as 200 with the same code and one row', function () {
    $path = '/api/v1/partner/public-chat/rooms';
    $body = ['customer_name' => 'Somchai', 'provider_name' => 'ACME', 'external_ref' => 'TICKET-7'];

    $first = pchatSigned('POST', $path, $body, $this->key->key_id, $this->secret);
    $second = pchatSigned('POST', $path, $body, $this->key->key_id, $this->secret);

    $first->assertStatus(201);
    // A replay is NOT an error: 200 with the identical id and code.
    $second->assertStatus(200)
        ->assertJsonPath('room.id', $first->json('room.id'))
        ->assertJsonPath('room.code', $first->json('room.code'));

    expect(PublicChatRoom::withoutGlobalScopes()->count())->toBe(1);
});

it('TC-PCHAT-008 answers 503 PCHAT_DISABLED with Retry-After when the feature is off, not 401', function () {
    app(SettingsService::class)->set('publicchat.enabled', false);

    $response = pchatSigned('POST', '/api/v1/partner/public-chat/rooms', [
        'customer_name' => 'Somchai', 'provider_name' => 'ACME',
    ], $this->key->key_id, $this->secret);

    // The gate runs AFTER verification on purpose: the partner must be able to
    // tell "your key is bad" from "the service is paused".
    $response->assertStatus(503)
        ->assertJsonPath('error.code', 'PCHAT_DISABLED')
        ->assertJsonPath('error.details.retry_after_seconds', 60)
        ->assertHeader('Retry-After', '60');

    expect(PublicChatRoom::withoutGlobalScopes()->count())->toBe(0);
});

it('TC-PCHAT-040 addresses partner rooms by ULID and 404s a 64-hex id', function () {
    $room = pchatCreateRoom($this->ws);

    pchatSigned('GET', '/api/v1/partner/public-chat/rooms/'.$room->id, null, $this->key->key_id, $this->secret)
        ->assertStatus(200)
        ->assertJsonPath('room.id', $room->id)
        ->assertJsonPath('room.status', 'new');

    // The visitor's credential is never a partner path segment — the route is
    // ->whereUlid, so a code shaped value does not route at all.
    pchatSigned('GET', '/api/v1/partner/public-chat/rooms/'.$room->code, null, $this->key->key_id, $this->secret)
        ->assertStatus(404);
});

it('TC-PCHAT-031 refuses a partner read of another workspace room', function () {
    $foreign = pchatCreateRoom($this->otherWs);

    pchatSigned('GET', '/api/v1/partner/public-chat/rooms/'.$foreign->id, null, $this->key->key_id, $this->secret)
        ->assertStatus(404)
        ->assertJsonPath('error.code', 'PCHAT_ROOM_NOT_FOUND');
});

it('TC-PCHAT-036 rotates the link: the old code 404s at once and the conversation survives', function () {
    $room = pchatCreateRoom($this->ws);
    $oldCode = $room->code;

    $response = pchatSigned('POST', '/api/v1/partner/public-chat/rooms/'.$room->id.'/rotate-link', null, $this->key->key_id, $this->secret);

    $response->assertStatus(200);
    $newCode = $response->json('room.code');

    expect($newCode)->not->toBe($oldCode)
        ->and($response->json('url'))->toContain($newCode);

    // Old link: gone immediately. New link: the SAME conversation, same id.
    $this->getJson('/api/v1/public-chat/'.$oldCode)->assertStatus(404);
    $this->getJson('/api/v1/public-chat/'.$newCode)
        ->assertStatus(200)
        ->assertJsonPath('room.id', $room->id);
});

it('closes a room over HMAC and 409s a second close', function () {
    $room = pchatCreateRoom($this->ws);

    pchatSigned('POST', '/api/v1/partner/public-chat/rooms/'.$room->id.'/close', null, $this->key->key_id, $this->secret)
        ->assertStatus(200)
        ->assertJsonPath('room.status', 'done');

    pchatSigned('POST', '/api/v1/partner/public-chat/rooms/'.$room->id.'/close', null, $this->key->key_id, $this->secret)
        ->assertStatus(409)
        ->assertJsonPath('error.code', 'PCHAT_ROOM_CLOSED');

    // The close is recorded in the transcript, in the reader's locale (body NULL).
    $system = PublicChatMessage::withoutGlobalScopes()->where('room_id', $room->id)->firstOrFail();
    expect($system->system_event)->toBe(PublicChatSystemEvent::ClosedByCustomer)
        ->and($system->body)->toBeNull()
        ->and($system->client_message_id)->not->toBeNull();
});

// ===========================================================================
// TIER 2 — visitor, unauthenticated (API-210..216)
// ===========================================================================

it('TC-PCHAT-014/032 serves the visitor a minimal payload that never contains the raw status or meta', function () {
    $room = pchatCreateRoom($this->ws, [
        'status' => PublicChatStatus::Problem->value,
        'assigned_to' => $this->agent->id,
        'meta' => ['order_id' => 'A-9', 'internal_note' => 'VIP'],
        'external_ref' => 'TICKET-9',
    ]);

    $response = $this->getJson('/api/v1/public-chat/'.$room->code);

    $response->assertStatus(200)
        // SecurityHeaders appends ", private"; no-store is the part that matters.
        ->assertHeader('Cache-Control', 'no-store, private')
        // `problem` projects to `open`. A customer must never learn support
        // flagged their conversation.
        ->assertJsonPath('room.status_public', 'open')
        ->assertJsonPath('can_send', true)
        ->assertJsonPath('viewer', null);

    $json = $response->json();
    $encoded = (string) json_encode($json);

    expect($json['room'])->not->toHaveKey('status')
        ->and($json['room'])->not->toHaveKey('meta')
        ->and($json['room'])->not->toHaveKey('assigned_to')
        ->and($json['room'])->not->toHaveKey('external_ref')
        ->and($encoded)->not->toContain('problem')
        ->and($encoded)->not->toContain($this->agent->id)
        ->and($encoded)->not->toContain('VIP')
        ->and($encoded)->not->toContain('TICKET-9')
        ->and($encoded)->not->toContain($this->ws->id);
});

it('TC-PCHAT-009/041 makes the visitor send idempotent on a required UUID client id', function () {
    $room = pchatCreateRoom($this->ws);
    $cid = (string) Str::uuid();

    $first = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => $cid, 'body' => 'สวัสดีครับ',
    ]);
    $second = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => $cid, 'body' => 'สวัสดีครับ',
    ]);

    $first->assertStatus(201);
    $second->assertStatus(200)->assertJsonPath('message.id', $first->json('message.id'));

    expect(PublicChatMessage::withoutGlobalScopes()->where('room_id', $room->id)->count())->toBe(1);

    // Required AND a UUID: the column is NOT NULL and part of the idempotency
    // unique, so a free-form or absent value is refused at the request layer.
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', ['body' => 'hi'])
        ->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', ['client_message_id' => 'not-a-uuid', 'body' => 'hi'])
        ->assertStatus(422);
});

it('TC-PCHAT-041 stops a visitor squatting an agent client_message_id', function () {
    $room = pchatCreateRoom($this->ws);
    $cid = (string) Str::uuid();

    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => $cid, 'body' => 'from the customer',
    ])->assertStatus(201);

    [, $token] = loginAs($this->agent);

    // sender_kind is the middle column of the unique, so the agent's send is a
    // NEW row rather than a 200 replay of the visitor's message.
    $agentSend = $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => $cid, 'body' => 'from support',
    ], wsHeaders($token, 'acme'));

    $agentSend->assertStatus(201)->assertJsonPath('message.body', 'from support');

    expect(PublicChatMessage::withoutGlobalScopes()->where('room_id', $room->id)->where('client_message_id', $cid)->count())->toBe(2);
});

it('TC-PCHAT-044/045 serves a signed-in member reads but refuses writes as the visitor', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    // Reads are fine: an agent may look at the customer's view.
    $this->getJson('/api/v1/public-chat/'.$room->code, authHeaders($token))
        ->assertStatus(200)
        ->assertJsonPath('viewer.kind', 'member')
        ->assertJsonPath('viewer.display_name', 'Somchai S.')
        // can_send is false for them — the composer must be replaced, not reused.
        ->assertJsonPath('can_send', false);

    // Writes are not: ApiClient attaches the bearer to every request, so without
    // this an agent checking on a conversation would post AS the customer.
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'oops',
    ], authHeaders($token))->assertStatus(403)->assertJsonPath('error.code', 'PCHAT_SIGNED_IN');

    // An invalid or expired bearer is 401 — NEVER silently anonymous.
    $this->getJson('/api/v1/public-chat/'.$room->code, authHeaders('dead-token'))
        ->assertStatus(401);
});

it('TC-PCHAT-028 keeps a done room readable while refusing sends, and reopens on demand', function () {
    $room = pchatCreateRoom($this->ws, [
        'status' => PublicChatStatus::Done->value,
        'assigned_to' => $this->agent->id,
        'closed_at' => now(),
    ]);

    $this->getJson('/api/v1/public-chat/'.$room->code)
        ->assertStatus(200)
        ->assertJsonPath('room.status_public', 'closed')
        ->assertJsonPath('can_send', false)
        ->assertJsonPath('closed_reason', 'done');

    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'still there?',
    ])->assertStatus(409)->assertJsonPath('error.code', 'PCHAT_ROOM_CLOSED');

    [, $token] = loginAs($this->agent);
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => 'in_progress'], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('room.status', 'in_progress');

    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'still there?',
    ])->assertStatus(201);
});

it('TC-PCHAT-029 answers 410 on every Tier-2 route once the link has expired', function () {
    $room = pchatCreateRoom($this->ws, ['expires_at' => now()->subMinute()]);

    foreach ([
        ['get', '/api/v1/public-chat/'.$room->code, []],
        ['get', '/api/v1/public-chat/'.$room->code.'/messages', []],
        ['post', '/api/v1/public-chat/'.$room->code.'/messages', ['client_message_id' => (string) Str::uuid(), 'body' => 'x']],
        ['post', '/api/v1/public-chat/'.$room->code.'/typing', []],
        // broadcasting/auth included deliberately: an open socket must not be
        // able to outlive the link.
        ['post', '/api/v1/public-chat/'.$room->code.'/broadcasting/auth', ['socket_id' => '1234.5678', 'channel_name' => 'private-public-chat.'.$room->id]],
    ] as [$method, $url, $payload]) {
        $response = $method === 'get' ? $this->getJson($url) : $this->postJson($url, $payload);

        $response->assertStatus(410)->assertJsonPath('error.code', 'PCHAT_LINK_EXPIRED');
    }
});

it('TC-PCHAT-026 keeps visitor reads alive with the feature off while refusing writes', function () {
    $room = pchatCreateRoom($this->ws);
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'before the pause',
    ])->assertStatus(201);

    app(SettingsService::class)->set('publicchat.enabled', false);

    // 200, not 503: the page shows a calm banner over a still-readable
    // transcript rather than an error screen that loses the receipt.
    $this->getJson('/api/v1/public-chat/'.$room->code)
        ->assertStatus(200)
        ->assertJsonPath('feature_enabled', false)
        ->assertJsonPath('can_send', false)
        ->assertJsonPath('closed_reason', 'disabled');

    $this->getJson('/api/v1/public-chat/'.$room->code.'/messages')
        ->assertStatus(200)
        ->assertJsonPath('messages.0.body', 'before the pause');

    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'during the pause',
    ])->assertStatus(503)->assertJsonPath('error.code', 'PCHAT_DISABLED');

    // Re-enabling resumes mid-conversation: nothing was closed, expired or lost.
    app(SettingsService::class)->set('publicchat.enabled', true);
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'after the pause',
    ])->assertStatus(201);

    expect(PublicChatMessage::withoutGlobalScopes()->where('room_id', $room->id)->count())->toBe(2);
});

it('TC-PCHAT-049 keys the visitor write limiter by code, so one room cannot exhaust another', function () {
    $roomA = pchatCreateRoom($this->ws);
    $roomB = pchatCreateRoom($this->ws);

    // pchat-visitor-write is 20/min BY CODE. Burn room A's budget...
    for ($i = 0; $i < 20; $i++) {
        $this->postJson('/api/v1/public-chat/'.$roomA->code.'/messages', [
            'client_message_id' => (string) Str::uuid(), 'body' => 'msg '.$i,
        ])->assertStatus(201);
    }

    $this->postJson('/api/v1/public-chat/'.$roomA->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'over',
    ])->assertStatus(429);

    // ...and room B, same IP, is untouched. A numeric throttle:N,1 would share
    // one cache key per IP here and fail this assertion.
    $this->postJson('/api/v1/public-chat/'.$roomB->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'fine',
    ])->assertStatus(201);
});

// ===========================================================================
// API-215 — the visitor channel-auth signing oracle (SECURITY tests)
// ===========================================================================

it('TC-PCHAT-016 signs the visitor channel for its own room', function () {
    $room = pchatCreateRoom($this->ws);

    $this->postJson('/api/v1/public-chat/'.$room->code.'/broadcasting/auth', [
        'socket_id' => '1234.5678',
        'channel_name' => 'private-public-chat.'.$room->id,
    ])->assertStatus(200)->assertHeader('Cache-Control', 'no-store, private');
});

it('TC-PCHAT-017 refuses to sign another room channel', function () {
    $room = pchatCreateRoom($this->ws);
    $other = pchatCreateRoom($this->otherWs);

    // The assertion is LITERAL STRING EQUALITY. This test exists so that
    // relaxing it to a prefix/regex/str_contains match — the kind of edit that
    // looks like a harmless generalisation — fails loudly.
    $this->postJson('/api/v1/public-chat/'.$room->code.'/broadcasting/auth', [
        'socket_id' => '1234.5678',
        'channel_name' => 'private-public-chat.'.$other->id,
    ])->assertStatus(404);
});

it('TC-PCHAT-018 refuses to sign the staff channel of its own room', function () {
    $room = pchatCreateRoom($this->ws);

    // -staff carries INTERNAL identity and is not derivable from any visitor
    // input. A prefix match would have signed this.
    $this->postJson('/api/v1/public-chat/'.$room->code.'/broadcasting/auth', [
        'socket_id' => '1234.5678',
        'channel_name' => 'private-public-chat-staff.'.$room->id,
    ])->assertStatus(404);
});

it('validates socket_id with anchors that a trailing newline cannot slip past', function () {
    $room = pchatCreateRoom($this->ws);

    // A trailing newline is stripped by the global TrimStrings middleware before
    // this code runs, so the \z anchor is exercised with an EMBEDDED one — the
    // case a naive ^..$ would wave through.
    foreach (['bogus', '1234', "1234.5678\nX", '1234.5678;x'] as $socketId) {
        $this->postJson('/api/v1/public-chat/'.$room->code.'/broadcasting/auth', [
            'socket_id' => $socketId,
            'channel_name' => 'private-public-chat.'.$room->id,
        ])->assertStatus(422);
    }
});

it('TC-PCHAT-019 authorises both room channels for an active member and nobody else', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);
    [, $outsiderToken] = loginAs($this->outsider);

    foreach (['private-public-chat.', 'private-public-chat-staff.'] as $prefix) {
        $this->postJson('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => $prefix.$room->id,
        ], authHeaders($token))->assertStatus(200);

        // A member of ANOTHER workspace is refused on both.
        $this->postJson('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => $prefix.$room->id,
        ], authHeaders($outsiderToken))->assertStatus(403);
    }
});

// ===========================================================================
// TIER 3 — agents (API-220..228)
// ===========================================================================

it('TC-PCHAT-011/047 auto-claims an unassigned room on the first agent reply and stamps first_response_at', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'สวัสดีครับ ยินดีช่วยเหลือ',
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    $room->refresh();

    expect($room->assigned_to)->toBe($this->agent->id)
        ->and($room->status)->toBe(PublicChatStatus::InProgress)
        ->and($room->claimed_at)->not->toBeNull()
        // MANDATORY graft 21 — the free first-response-time metric.
        ->and($room->first_response_at)->not->toBeNull();

    $system = PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $room->id)
        ->where('sender_kind', PublicChatSenderKind::System->value)
        ->get();

    expect($system)->toHaveCount(1)
        ->and($system->first()->system_event)->toBe(PublicChatSystemEvent::Claimed);

    Event::assertDispatched(PublicChatRoomChanged::class);
    Event::assertDispatched(PublicChatRoomChangedStaff::class);
});

it('TC-PCHAT-010 claims exactly once under two agent replies and keeps seq gapless', function () {
    $room = pchatCreateRoom($this->ws);
    [, $tokenA] = loginAs($this->agent);
    [, $tokenB] = loginAs($this->agent2);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'first',
    ], wsHeaders($tokenA, 'acme'))->assertStatus(201);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'second',
    ], wsHeaders($tokenB, 'acme'))->assertStatus(201);

    $room->refresh();

    // The claim runs inside the same lockForUpdate that assigns seq, so the
    // second agent finds the room already claimed rather than racing for it.
    expect($room->assigned_to)->toBe($this->agent->id);

    $claims = PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $room->id)
        ->where('system_event', PublicChatSystemEvent::Claimed->value)
        ->count();

    expect($claims)->toBe(1);

    $seqs = PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $room->id)->orderBy('seq')->pluck('seq')->all();

    expect($seqs)->toBe(range(1, count($seqs)))
        ->and((int) $room->last_seq)->toBe(count($seqs));
});

it('TC-PCHAT-013 renders an agent externally as "Provider (username)" and internally as the user', function () {
    $room = pchatCreateRoom($this->ws, ['provider_name' => 'ACME Support']);
    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'we are on it',
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    // The customer sees the snapshot-built external name and no user ULID.
    $visitor = $this->getJson('/api/v1/public-chat/'.$room->code.'/messages');
    $visitor->assertStatus(200);
    $agentRow = collect($visitor->json('messages'))->firstWhere('sender_kind', 'agent');

    expect($agentRow['display_name'])->toBe('ACME Support (somchai)')
        ->and($agentRow)->not->toHaveKey('sender')
        ->and((string) json_encode($visitor->json()))->not->toContain($this->agent->id);

    // Staff see the real user.
    $staff = $this->getJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', wsHeaders($token, 'acme'));
    $staffRow = collect($staff->json('messages'))->firstWhere('sender_kind', 'agent');

    expect($staffRow['sender']['username'])->toBe('somchai')
        ->and($staffRow['external_display_name'])->toBe('ACME Support (somchai)');

    // A later rename does NOT rewrite the customer's transcript: the name comes
    // from write-time snapshots and `users` is never joined on the public side.
    $this->agent->forceFill(['username' => 'somchai2'])->save();

    $after = $this->getJson('/api/v1/public-chat/'.$room->code.'/messages');
    expect(collect($after->json('messages'))->firstWhere('sender_kind', 'agent')['display_name'])
        ->toBe('ACME Support (somchai)');
});

it('TC-PCHAT-035 exposes a reply snippet to the visitor without any sender identity', function () {
    $room = pchatCreateRoom($this->ws);

    $first = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'question one about billing',
    ])->assertStatus(201);

    [, $token] = loginAs($this->agent);
    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'answering that one',
        'reply_to_message_id' => $first->json('message.id'),
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    $messages = $this->getJson('/api/v1/public-chat/'.$room->code.'/messages')->json('messages');
    $reply = collect($messages)->firstWhere('body', 'answering that one');

    expect($reply['reply_to']['snippet'])->toBe('question one about billing')
        ->and($reply['reply_to'])->toHaveKeys(['id', 'seq', 'snippet'])
        // The snippet is the point; the author is the leak the public payload is
        // designed against.
        ->and($reply['reply_to'])->not->toHaveKey('sender')
        ->and($reply['reply_to'])->not->toHaveKey('sender_kind');
});

it('TC-PCHAT-012 persists every status transition and a reassignment, with a system row each', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    // The sole guard: a room may not sit in any status but `new` unassigned.
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => 'in_progress'], wsHeaders($token, 'acme'))
        ->assertStatus(422)->assertJsonPath('error.code', 'PCHAT_INVALID_TRANSITION');

    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, [
        'status' => 'in_progress', 'assigned_to' => $this->agent->id,
    ], wsHeaders($token, 'acme'))->assertStatus(200)->assertJsonPath('room.status', 'in_progress');

    foreach (['problem', 'done', 'in_progress'] as $status) {
        $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => $status], wsHeaders($token, 'acme'))
            ->assertStatus(200)->assertJsonPath('room.status', $status);
    }

    // Reassignment to another active member.
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['assigned_to' => $this->agent2->id], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('room.assigned_to.username', 'anna');

    // A non-member cannot be assigned (Decision A: active member of THIS ws).
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['assigned_to' => $this->outsider->id], wsHeaders($token, 'acme'))
        ->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');

    $room->refresh();
    expect($room->assigned_to)->toBe($this->agent2->id)
        ->and($room->closed_at)->toBeNull(); // cleared when reopened from done

    $events = PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $room->id)
        ->whereNotNull('system_event')
        ->pluck('system_event')->map(fn ($e) => $e->value)->all();

    expect($events)->toContain(PublicChatSystemEvent::Claimed->value)
        ->toContain(PublicChatSystemEvent::StatusChanged->value)
        ->toContain(PublicChatSystemEvent::Reassigned->value);
});

it('TC-PCHAT-032 never leaks `problem` through a status_changed system row', function () {
    // DEC-074 — the projection alone was not enough. `problem` and
    // `in_progress` BOTH project to 'open', so a `status_changed` row emitted
    // for that transition rendered as "open -> open": every field correctly
    // redacted, and the EXISTENCE of the row, timed to the agent's click, still
    // told the customer support had just flagged them. The visitor-side row is
    // therefore suppressed when both ends project equal — and only then.
    //
    // Three properties, and all three are needed. Suppressing everything would
    // hide a real close; suppressing nothing re-opens the side channel; and
    // suppressing on the staff side too would put a hole in the audit trail.
    $room = pchatCreateRoom($this->ws, ['status' => PublicChatStatus::InProgress->value, 'assigned_to' => $this->agent->id]);
    [, $token] = loginAs($this->agent);

    $statusPublic = fn () => $this->getJson('/api/v1/public-chat/'.$room->code)
        ->assertStatus(200)->json('room.status_public');

    $visitorStatusRows = function () use ($room) {
        $response = $this->getJson('/api/v1/public-chat/'.$room->code.'/messages');
        $response->assertStatus(200);

        // The raw flag must not appear ANYWHERE in the payload — not in a row
        // we forgot to filter, not in an actor_username, not in a room block.
        expect((string) json_encode($response->json()))->not->toContain('problem')
            ->and((string) json_encode($response->json()))->not->toContain('somchai');

        return array_values(array_filter(
            $response->json('messages'),
            fn (array $m) => ($m['system_event'] ?? null) === 'status_changed',
        ));
    };

    expect($statusPublic())->toBe('open')
        ->and($visitorStatusRows())->toBe([]);

    // (1) ZERO DELTA — in_progress -> problem. Both project to 'open'.
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => 'problem'], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('room.status', 'problem');

    // NO visitor-visible system row at all, and the visitor's own view of the
    // status has not moved. Omitted rather than replaced with a placeholder: a
    // placeholder would re-leak the timing the suppression exists to hide.
    expect($visitorStatusRows())->toBe([])
        ->and($statusPublic())->toBe('open');

    // The row IS written. This is a boundary suppression, not a gap in the
    // record — staff and the audit trail keep the truth (asserted at (3)).
    expect(PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $room->id)
        ->where('system_event', PublicChatSystemEvent::StatusChanged->value)
        ->count())->toBe(1);

    // (2) REAL DELTA — problem -> done projects open -> closed. The visitor is
    // entitled to see their conversation close, and the row that says so must
    // carry PROJECTED values on BOTH ends: `from` is literally 'problem' in the
    // database, and 'open' is what the customer may be told it was.
    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => 'done'], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('room.status', 'done');

    $rows = $visitorStatusRows();

    expect($rows)->toHaveCount(1)
        ->and($rows[0]['system_meta'])->toBe(['from' => 'open', 'to' => 'closed'])
        ->and($statusPublic())->toBe('closed');

    // (3) STAFF ALWAYS SEE THE TRUE TRANSITION, zero-delta included. An agent
    // picking up the room must be able to tell it was flagged, and when.
    $staff = $this->getJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', wsHeaders($token, 'acme'));
    $staff->assertStatus(200);

    $staffRows = array_values(array_filter(
        $staff->json('messages'),
        fn (array $m) => ($m['system_event'] ?? null) === 'status_changed',
    ));

    expect($staffRows)->toHaveCount(2)
        ->and($staffRows[0]['system_meta']['from'])->toBe('in_progress')
        ->and($staffRows[0]['system_meta']['to'])->toBe('problem')
        ->and($staffRows[1]['system_meta']['from'])->toBe('problem')
        ->and($staffRows[1]['system_meta']['to'])->toBe('done');
});

it('TC-PCHAT-046 sorts the queue problem, then needs_reply, then recency', function () {
    [, $token] = loginAs($this->agent);

    $stale = pchatCreateRoom($this->ws, ['customer_name' => 'Stale', 'last_message_at' => now()->subDay()]);
    $chatty = pchatCreateRoom($this->ws, ['customer_name' => 'Chatty', 'status' => PublicChatStatus::Done->value, 'assigned_to' => $this->agent->id, 'last_message_at' => now()]);
    $waiting = pchatCreateRoom($this->ws, ['customer_name' => 'Waiting', 'last_visitor_seq' => 3, 'last_agent_seq' => 1, 'last_message_at' => now()->subHour()]);
    $flagged = pchatCreateRoom($this->ws, ['customer_name' => 'Flagged', 'status' => PublicChatStatus::Problem->value, 'assigned_to' => $this->agent->id, 'last_message_at' => now()->subWeek()]);

    $names = collect($this->getJson('/api/v1/public-chat/rooms', wsHeaders($token, 'acme'))->json('rooms'))
        ->pluck('customer_name')->all();

    // A flagged week-old room outranks a chatty resolved one — which is exactly
    // what ordering by recency alone gets wrong.
    expect($names)->toBe(['Flagged', 'Waiting', 'Chatty', 'Stale']);

    // Filters are server-side.
    $filtered = $this->getJson('/api/v1/public-chat/rooms?status=problem', wsHeaders($token, 'acme'))->json('rooms');
    expect($filtered)->toHaveCount(1)->and($filtered[0]['customer_name'])->toBe('Flagged');

    $mine = $this->getJson('/api/v1/public-chat/rooms?assigned=me', wsHeaders($token, 'acme'))->json('rooms');
    expect(collect($mine)->pluck('customer_name')->all())->toBe(['Flagged', 'Chatty']);

    $unassigned = $this->getJson('/api/v1/public-chat/rooms?assigned=none', wsHeaders($token, 'acme'))->json('rooms');
    expect(collect($unassigned)->pluck('customer_name')->all())->toBe(['Waiting', 'Stale']);

    $needsReply = $this->getJson('/api/v1/public-chat/rooms?needs_reply=1', wsHeaders($token, 'acme'))->json('rooms');
    expect(collect($needsReply)->pluck('customer_name')->all())->toBe(['Waiting']);

    expect($stale->id)->not->toBe($flagged->id); // fixtures are distinct rows
});

it('TC-PCHAT-033 finds a room by what the customer actually said', function () {
    $room = pchatCreateRoom($this->ws, ['customer_name' => 'Pim']);
    pchatCreateRoom($this->ws, ['customer_name' => 'Noi']);

    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'my invoice number is INV-4471',
    ])->assertStatus(201);

    [, $token] = loginAs($this->agent);

    $hits = $this->getJson('/api/v1/public-chat/rooms?q=INV-4471', wsHeaders($token, 'acme'))->json('rooms');
    expect($hits)->toHaveCount(1)->and($hits[0]['id'])->toBe($room->id);

    // The three name columns still match too.
    $byName = $this->getJson('/api/v1/public-chat/rooms?q=Noi', wsHeaders($token, 'acme'))->json('rooms');
    expect($byName)->toHaveCount(1)->and($byName[0]['customer_name'])->toBe('Noi');
});

it('TC-PCHAT-042 moves the read pointer monotonically and reports the effective seq', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    foreach (range(1, 3) as $i) {
        $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
            'client_message_id' => (string) Str::uuid(), 'body' => 'msg '.$i,
        ])->assertStatus(201);
    }

    $this->getJson('/api/v1/public-chat/rooms/'.$room->id, wsHeaders($token, 'acme'))
        ->assertStatus(200)
        ->assertJsonPath('room.my_last_read_seq', 0)
        ->assertJsonPath('room.unread_count', 3)
        ->assertJsonPath('room.needs_reply', true);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/read', ['seq' => 3], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('last_read_seq', 3)->assertJsonPath('unread_count', 0);

    // A lower seq is a no-op at the DATABASE level (ON CONFLICT ... GREATEST),
    // and the response reports the pointer actually in force.
    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/read', ['seq' => 1], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('last_read_seq', 3);

    expect(PublicChatRead::query()->where('room_id', $room->id)->where('user_id', $this->agent->id)->value('last_read_seq'))->toBe(3);

    // The pointer is PER AGENT and never changes queue order.
    $this->getJson('/api/v1/public-chat/rooms/'.$room->id, wsHeaders($token, 'acme'))
        ->assertJsonPath('room.unread_count', 0);

    [, $token2] = loginAs($this->agent2);
    $this->getJson('/api/v1/public-chat/rooms/'.$room->id, wsHeaders($token2, 'acme'))
        ->assertJsonPath('room.unread_count', 3);
});

it('reports the rail summary and soft-deletes a message for any active member', function () {
    $room = pchatCreateRoom($this->ws);
    pchatCreateRoom($this->ws, ['status' => PublicChatStatus::Problem->value, 'assigned_to' => $this->agent->id]);

    $sent = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => '4111 1111 1111 1111',
    ])->assertStatus(201);

    [, $token] = loginAs($this->agent);

    $this->getJson('/api/v1/public-chat/summary', wsHeaders($token, 'acme'))
        ->assertStatus(200)
        ->assertJsonPath('summary.new', 1)
        ->assertJsonPath('summary.problem', 1)
        ->assertJsonPath('summary.mine', 1)
        ->assertJsonPath('feature_enabled', true);

    // API-226 exists because MessageEditor's moderator branch would have made a
    // NULL-sender row undeletable by anyone.
    $this->deleteJson('/api/v1/public-chat/messages/'.$sent->json('message.id'), [], wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('message.deleted', true);

    Event::assertDispatched(PublicChatMessageDeleted::class);

    // The row STAYS (no SoftDeletes trait) so seq is not renumbered, and each
    // serializer renders the tombstone itself.
    $visitor = $this->getJson('/api/v1/public-chat/'.$room->code.'/messages')->json('messages');
    expect($visitor)->toHaveCount(1)
        ->and($visitor[0]['deleted'])->toBeTrue()
        ->and($visitor[0]['body'])->toBeNull()
        ->and($visitor[0]['seq'])->toBe(1);
});

it('TC-PCHAT-031 404s every Tier-3 endpoint for another workspace room', function () {
    $foreign = pchatCreateRoom($this->otherWs);
    [, $token] = loginAs($this->agent);

    $this->getJson('/api/v1/public-chat/rooms/'.$foreign->id, wsHeaders($token, 'acme'))->assertStatus(404);
    $this->getJson('/api/v1/public-chat/rooms/'.$foreign->id.'/messages', wsHeaders($token, 'acme'))->assertStatus(404);
    $this->patchJson('/api/v1/public-chat/rooms/'.$foreign->id, ['status' => 'problem'], wsHeaders($token, 'acme'))->assertStatus(404);
    $this->postJson('/api/v1/public-chat/rooms/'.$foreign->id.'/read', ['seq' => 1], wsHeaders($token, 'acme'))->assertStatus(404);
    $this->postJson('/api/v1/public-chat/rooms/'.$foreign->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'x',
    ], wsHeaders($token, 'acme'))->assertStatus(404);

    // And the list never contains it.
    expect($this->getJson('/api/v1/public-chat/rooms', wsHeaders($token, 'acme'))->json('rooms'))->toBe([]);
});

it('TC-PCHAT-024/025 gives a public chat room no call surface and keeps it out of GET /rooms', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    // Calls must be ENABLED or the endpoint 503s before it ever looks at the id,
    // which would make this assertion vacuous.
    config(['calls.enabled' => true, 'calls.secret' => 'test-secret', 'calls.url' => 'wss://livekit.test']);

    // Structural, not a gate: the id is not in `rooms`, so nothing resolves.
    $this->postJson('/api/v1/rooms/'.$room->id.'/calls', ['kind' => 'video'], wsHeaders($token, 'acme'))
        ->assertStatus(404);

    $rooms = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'));
    $rooms->assertStatus(200);
    expect((string) json_encode($rooms->json()))->not->toContain($room->id);
});

it('TC-PCHAT-034 pushes only to the assigned agent and to nobody when unassigned', function () {
    $room = pchatCreateRoom($this->ws);

    $unassignedMessage = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'hello?',
    ])->json('message.id');

    Event::fake(pchatFakedEvents());
    app()->call([new NotifyPublicChatMessage($unassignedMessage), 'handle']);

    // Deliberately NOBODY: the queue badge is the signal for an unclaimed room.
    // Waking every workspace member for every unassigned customer message is how
    // a support integration trains its users to mute notifications.
    Event::assertNotDispatched(NotificationAlert::class);

    $room->forceFill(['assigned_to' => $this->agent->id, 'status' => PublicChatStatus::InProgress->value])->save();

    $assignedMessage = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'still hello?',
    ])->json('message.id');

    Event::fake(pchatFakedEvents());
    app()->call([new NotifyPublicChatMessage($assignedMessage), 'handle']);

    Event::assertDispatched(NotificationAlert::class, function (NotificationAlert $e) use ($room) {
        // room_id MUST be null: the web client resolves it against `rooms`, and
        // a public chat ULID there would open a room that does not exist.
        return $e->userId === $this->agent->id
            && $e->roomId === null
            && $e->kind === 'public_chat'
            && $e->workspace === $room->workspace_id;
    });
});

it('never notifies for an agent or system row', function () {
    $room = pchatCreateRoom($this->ws, ['assigned_to' => $this->agent->id, 'status' => PublicChatStatus::InProgress->value]);
    [, $token] = loginAs($this->agent);

    $agentMessage = $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'from support',
    ], wsHeaders($token, 'acme'))->json('message.id');

    Event::fake(pchatFakedEvents());
    app()->call([new NotifyPublicChatMessage($agentMessage), 'handle']);

    Event::assertNotDispatched(NotificationAlert::class);
});

it('broadcasts the public and staff message variants on separate channels', function () {
    $room = pchatCreateRoom($this->ws);
    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'we are on it',
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    Event::assertDispatched(PublicChatMessageCreated::class, function (PublicChatMessageCreated $e) use ($room) {
        $channels = array_map('strval', $e->broadcastOn());
        $encoded = (string) json_encode($e->broadcastWith());

        // The visitor channel: keyed by the ULID, never carrying the code or a
        // user ULID, and never carrying the workspace id.
        return $channels === ['private-public-chat.'.$room->id]
            && ! str_contains($encoded, $room->code)
            && ! str_contains($encoded, $this->agent->id)
            && $e->broadcastWith()['workspace_id'] === null;
    });

    Event::assertDispatched(PublicChatMessageCreatedStaff::class, function (PublicChatMessageCreatedStaff $e) use ($room) {
        $channels = array_map('strval', $e->broadcastOn());

        return $channels === ['private-public-chat-staff.'.$room->id]
            // The `claimed` system row broadcasts here too and has a null sender.
            && ($e->message['sender']['username'] ?? null) === 'somchai';
    });
});

it('refuses every agent write with the feature off while leaving reads alone', function () {
    $room = pchatCreateRoom($this->ws, ['assigned_to' => $this->agent->id, 'status' => PublicChatStatus::InProgress->value]);
    [, $token] = loginAs($this->agent);

    app(SettingsService::class)->set('publicchat.enabled', false);

    $this->postJson('/api/v1/public-chat/rooms/'.$room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'x',
    ], wsHeaders($token, 'acme'))->assertStatus(503)->assertJsonPath('error.code', 'PCHAT_DISABLED');

    $this->patchJson('/api/v1/public-chat/rooms/'.$room->id, ['status' => 'problem'], wsHeaders($token, 'acme'))
        ->assertStatus(503);

    // Reads keep working, so the rail shows a "paused" chip rather than going blank.
    $this->getJson('/api/v1/public-chat/rooms', wsHeaders($token, 'acme'))->assertStatus(200);
    $this->getJson('/api/v1/public-chat/summary', wsHeaders($token, 'acme'))
        ->assertStatus(200)->assertJsonPath('feature_enabled', false);
});

it('requires an authenticated workspace member for every Tier-3 route', function () {
    $room = pchatCreateRoom($this->ws);

    $this->getJson('/api/v1/public-chat/rooms')->assertStatus(401);

    [, $outsiderToken] = loginAs($this->outsider);
    $this->getJson('/api/v1/public-chat/rooms', wsHeaders($outsiderToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'WS_FORBIDDEN');

    expect($room->id)->toBeString();
});

it('canonicalises the signed path with the /api/v1 prefix and ignores the query string', function () {
    $path = '/api/v1/partner/public-chat/rooms';
    $raw = (string) json_encode(['customer_name' => 'Somchai', 'provider_name' => 'ACME']);

    // The signature covers getPathInfo() — leading slash, /api/v1 included, no
    // query string — so a trace parameter does not break it.
    $headers = pchatServerVars(pchatHeaders($this->key->key_id, $this->secret, 'POST', $path, $raw));

    $this->call('POST', $path.'?trace=1', [], [], [], $headers, $raw)->assertStatus(201);

    // Signing the path WITHOUT the /api/v1 prefix is a 401, not a near miss.
    $wrong = pchatServerVars(pchatHeaders($this->key->key_id, $this->secret, 'POST', '/partner/public-chat/rooms', $raw));

    $this->call('POST', $path, [], [], [], $wrong, $raw)
        ->assertStatus(401)->assertJsonPath('error.code', 'API_SIGNATURE_INVALID');

    expect(Hmac::canonical('POST', $path, '1', 'n', ''))->toContain("\n".$path."\n");
});

// ===========================================================================
// FR-PCHAT-030/032 — the credential service the Filament admin consumes
// ===========================================================================

it('TC-PCHAT-048 issues a key whose plaintext secret never reaches audit_logs', function () {
    $admin = User::factory()->systemAdmin()->create();

    $issued = app(PublicChatApiKeyService::class)->issue($this->ws->id, 'Storefront', $admin);

    expect($issued['key_id'])->toMatch('/\Apck_[0-9a-f]{28}\z/')
        ->and($issued['secret'])->toMatch('/\Apcs_[0-9a-f]{64}\z/')
        // Encrypted under APP_KEY, not hashed (DEC-062): HMAC verification must
        // recompute the MAC with the key material, and a digest cannot supply one.
        ->and($issued['key']->plainSecret())->toBe($issued['secret'])
        ->and($issued['key']->maskedSecret())->toBe('****'.substr($issued['secret'], -4))
        // $hidden: a stray ->toArray() must not carry the ciphertext.
        ->and($issued['key']->toArray())->not->toHaveKey('secret_ciphertext');

    $audit = AuditLog::query()->where('action', 'public_chat.api_key_issued')->latest('created_at')->firstOrFail();
    $context = (string) json_encode($audit->context);

    // key_id is the PUBLIC identifier and is safe to log; the secret is not, and
    // this assertion is the contract guard for every future edit to issue().
    expect($context)->toContain($issued['key_id'])
        ->and($context)->not->toContain($issued['secret'])
        ->and($context)->not->toContain($issued['key']->secret_ciphertext);

    // Revocation is a row UPDATE, so the audit trail survives...
    app(PublicChatApiKeyService::class)->revoke($issued['key'], $admin);
    expect($issued['key']->fresh()->isRevoked())->toBeTrue();

    // ...and every later signed call with that key_id is 401 at step 3.
    pchatSigned('POST', '/api/v1/partner/public-chat/rooms', [
        'customer_name' => 'Somchai', 'provider_name' => 'ACME',
    ], $issued['key_id'], $issued['secret'])
        ->assertStatus(401)->assertJsonPath('error.code', 'API_KEY_INVALID');
});

it('TC-PCHAT-005 keeps rooms a revoked key created open, with working links', function () {
    $admin = User::factory()->systemAdmin()->create();
    $room = pchatCreateRoom($this->ws, ['api_key_id' => $this->key->id]);

    app(PublicChatApiKeyService::class)->revoke($this->key, $admin);

    // FR-PCHAT-032 — a key is an integration credential, not the owner of
    // customer conversations. Killing live chats because an ops key rotated
    // would be a worse failure than the one revocation exists to prevent.
    $this->getJson('/api/v1/public-chat/'.$room->code)->assertStatus(200);
    $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'still works',
    ])->assertStatus(201);
});
