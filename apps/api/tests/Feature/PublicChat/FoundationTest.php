<?php

use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\WorkspaceStatus;
use App\Exceptions\ApiException;
use App\Http\Middleware\VerifyPublicChatSignature as Hmac;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRead;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * FR-PCHAT-001/002/010/020/030/031/033 — foundation: schema, models, and the
 * Tier-1 HMAC middleware.
 *
 * TC-PCHAT-002 body tamper · 003 timestamp skew · 004 nonce replay · 005 revoked
 * key · 037 last_used_at once/min · 038 undecryptable secret · 039 system-row
 * ULID client id · 041 idempotency key includes sender_kind · 042 read pointer ·
 * 043 attachments_owner_chk · 050 verification order.
 */
// Pest loads every test file into ONE process, so these globals are guarded:
// the API-agent's TC-PCHAT-001..008 suite will need the same signing helpers and
// a redeclaration is a fatal, not a warning. Reuse these rather than redefining
// them — Hmac::canonical() is the single definition of the canonical string.
if (! defined('PROBE_PATH')) {
    define('PROBE_PATH', '/api/v1/partner/public-chat/_foundation_probe');
}

if (! function_exists('pchatProbeRoute')) {
    /** Registers a throwaway route behind the real `api.hmac` alias. */
    function pchatProbeRoute(): void
    {
        Route::middleware(['api.hmac'])->post(PROBE_PATH, function (Request $request) {
            $key = $request->attributes->get(Hmac::REQUEST_ATTRIBUTE);

            return response()->json([
                'ok' => true,
                'key_id' => $key?->key_id,
                // Proves step 6 ran: the controller can rely on WorkspaceContext.
                'context_workspace_id' => app(WorkspaceContext::class)->id(),
            ]);
        });

        // A second probe that throws the kill-switch error, so DEC-067's
        // Retry-After header is asserted end to end through the §7 renderer.
        Route::middleware(['api.hmac'])->post(PROBE_PATH.'_disabled', function () {
            throw ApiException::pchatDisabled();
        });
    }
}

if (! function_exists('pchatHeaders')) {
    /**
     * Builds the four signature headers over the RAW body bytes, exactly as the
     * partner docs must instruct. `$overrides` lets a test corrupt one field.
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

beforeEach(function () {
    pchatProbeRoute();

    $this->workspace = Workspace::factory()->create();
    $this->secret = PublicChatApiKey::generateSecret();
    $this->key = PublicChatApiKey::query()->create([
        'workspace_id' => $this->workspace->id,
        'name' => 'Partner Integration',
        'key_id' => PublicChatApiKey::generateKeyId(),
        'secret_ciphertext' => Crypt::encryptString($this->secret),
        'secret_last4' => substr($this->secret, -4),
    ]);
});

if (! function_exists('pchatProbe')) {
    /** POSTs a signed request to the probe route. */
    function pchatProbe(array $body, string $keyId, string $secret, array $overrides = [], string $path = PROBE_PATH): TestResponse
    {
        $raw = json_encode($body);

        return test()->call(
            'POST',
            $path,
            [], [], [],
            collect(pchatHeaders($keyId, $secret, 'POST', $path, $raw, $overrides))
                ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])
                ->all(),
            $raw,
        );
    }
}

// =====================================================================
// SCHEMA — FR-PCHAT-001/002/010/020
// =====================================================================

test('FR-PCHAT-001/002/010 every public chat table, column and index exists', function () {
    $tables = DB::table('information_schema.tables')
        ->where('table_schema', 'public')
        ->whereIn('table_name', [
            'public_chat_api_keys', 'public_chat_rooms', 'public_chat_messages',
            'public_chat_message_attachments', 'public_chat_reads',
        ])->pluck('table_name')->sort()->values()->all();

    expect($tables)->toBe([
        'public_chat_api_keys', 'public_chat_message_attachments',
        'public_chat_messages', 'public_chat_reads', 'public_chat_rooms',
    ]);

    $columns = fn (string $t) => DB::table('information_schema.columns')
        ->where('table_schema', 'public')->where('table_name', $t)
        ->pluck('is_nullable', 'column_name')->all();

    $keys = $columns('public_chat_api_keys');
    expect(array_keys($keys))->toContain('key_id', 'secret_ciphertext', 'secret_last4', 'created_by_admin_id', 'last_used_at', 'revoked_at');

    $rooms = $columns('public_chat_rooms');
    foreach (['workspace_id', 'api_key_id', 'code', 'customer_name', 'provider_name', 'status',
        'assigned_to', 'claimed_at', 'first_response_at', 'external_ref', 'meta', 'locale',
        'last_seq', 'last_visitor_seq', 'last_agent_seq', 'last_message_at', 'expires_at',
        'closed_at', 'deleted_at'] as $c) {
        expect(array_keys($rooms))->toContain($c);
    }

    $messages = $columns('public_chat_messages');
    foreach (['room_id', 'workspace_id', 'seq', 'sender_kind', 'sender_user_id',
        'agent_username_snapshot', 'provider_name_snapshot', 'type', 'body', 'system_event',
        'system_meta', 'reply_to_message_id', 'client_message_id', 'deleted_at', 'deleted_by'] as $c) {
        expect(array_keys($messages))->toContain($c);
    }
    // DEC-066 — no column of the idempotency key may be nullable.
    expect($messages['client_message_id'])->toBe('NO');

    $indexes = DB::table('pg_indexes')->where('schemaname', 'public')
        ->whereIn('tablename', ['public_chat_rooms', 'public_chat_messages', 'public_chat_api_keys', 'public_chat_reads'])
        ->pluck('indexdef', 'indexname')->all();

    foreach (['public_chat_api_keys_ws_revoked_idx', 'public_chat_rooms_ws_assignee_idx',
        'public_chat_rooms_ws_status_recent_idx', 'public_chat_rooms_ws_external_ref_uniq',
        'public_chat_messages_room_seq_uniq', 'public_chat_messages_idem_uniq',
        'public_chat_messages_room_seq_desc_idx', 'public_chat_messages_body_trgm_idx',
        'public_chat_reads_user_ws_idx'] as $name) {
        expect(array_keys($indexes))->toContain($name);
    }

    // The create-idempotency unique is PARTIAL, and excludes api_key_id so a
    // key rotation does not turn the partner's retry into a duplicate room.
    expect($indexes['public_chat_rooms_ws_external_ref_uniq'])
        ->toContain('WHERE (external_ref IS NOT NULL)')
        ->not->toContain('api_key_id');

    expect($indexes['public_chat_rooms_ws_status_recent_idx'])->toContain('last_message_at DESC');
    expect($indexes['public_chat_messages_idem_uniq'])->toContain('sender_kind');
});

test('FR-PCHAT-020 attachments.uploader_id is nullable and carries the public chat partition column', function () {
    $cols = DB::table('information_schema.columns')
        ->where('table_schema', 'public')->where('table_name', 'attachments')
        ->pluck('is_nullable', 'column_name')->all();

    expect($cols['uploader_id'])->toBe('YES')          // without this, visitor upload is impossible
        ->and($cols)->toHaveKey('public_chat_room_id')
        ->and($cols['public_chat_room_id'])->toBe('YES');
});

test('TC-PCHAT-043 attachments_owner_chk makes an attachment owned by nobody unrepresentable', function () {
    $constraint = DB::table('pg_constraint')->where('conname', 'attachments_owner_chk')->first();
    expect($constraint)->not->toBeNull()
        ->and($constraint->convalidated)->toBeTrue();

    $insert = fn (?string $uploaderId, ?string $roomId) => DB::table('attachments')->insert([
        'id' => strtolower((string) Str::ulid()),
        'workspace_id' => $this->workspace->id,
        'uploader_id' => $uploaderId,
        'public_chat_room_id' => $roomId,
        'kind' => 'file', 'status' => 'pending',
        'original_name' => 'x.txt', 'mime_type' => 'text/plain',
        'size_bytes' => 1, 'storage_key' => 'k/'.Str::random(8),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    // Nested in its own transaction so the expected constraint violation rolls
    // back to a SAVEPOINT instead of poisoning RefreshDatabase's outer transaction.
    expect(fn () => DB::transaction(fn () => $insert(null, null)))->toThrow(QueryException::class);

    $room = PublicChatRoom::query()->create([
        'workspace_id' => $this->workspace->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'Somchai', 'provider_name' => 'Acme Co',
    ]);

    // A visitor-owned attachment (no uploader) is legal; so is an internal one.
    $insert(null, $room->id);
    $insert(User::factory()->create()->id, null);
    expect(DB::table('attachments')->count())->toBe(2);
});

// =====================================================================
// MODELS
// =====================================================================

test('TC-PCHAT-041 the idempotency unique is (room_id, sender_kind, client_message_id) so a visitor cannot squat an agent client id', function () {
    $room = PublicChatRoom::query()->create([
        'workspace_id' => $this->workspace->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'Somchai', 'provider_name' => 'Acme Co',
    ]);

    $shared = (string) Str::uuid();
    $write = fn (string $kind, int $seq) => DB::table('public_chat_messages')->insert([
        'id' => strtolower((string) Str::ulid()),
        'room_id' => $room->id, 'workspace_id' => $this->workspace->id,
        'seq' => $seq, 'sender_kind' => $kind, 'type' => 'text', 'body' => 'hi',
        'client_message_id' => $shared, 'created_at' => now(),
    ]);

    $write('visitor', 1);
    // Same client id, different sender_kind — must NOT collide, or the agent's
    // send silently returns the visitor's row as a 200 replay.
    $write('agent', 2);
    expect(DB::table('public_chat_messages')->count())->toBe(2);

    // Same triple twice — the replay the visitor endpoint relies on.
    expect(fn () => DB::transaction(fn () => $write('visitor', 3)))->toThrow(QueryException::class);
});

test('TC-PCHAT-039 system rows get a server-generated ULID client id', function () {
    $id = PublicChatMessage::newSystemClientId();

    expect($id)->toHaveLength(26)->toMatch('/\A[0-9a-hjkmnp-tv-z]{26}\z/');
});

test('FR-PCHAT-001 status_public never leaks the internal problem flag', function () {
    expect(PublicChatStatus::New->public())->toBe('open')
        ->and(PublicChatStatus::InProgress->public())->toBe('open')
        ->and(PublicChatStatus::Problem->public())->toBe('open')
        ->and(PublicChatStatus::Done->public())->toBe('closed');
});

test('FR-PCHAT-030/031 the api key model hides the ciphertext and round-trips the secret', function () {
    expect($this->key->toArray())->not->toHaveKey('secret_ciphertext')
        ->and($this->key->plainSecret())->toBe($this->secret)
        ->and($this->key->maskedSecret())->toBe('****'.substr($this->secret, -4))
        ->and($this->key->key_id)->toMatch('/\Apck_[0-9a-f]{28}\z/')
        ->and($this->secret)->toMatch('/\Apcs_[0-9a-f]{64}\z/');
});

test('TC-PCHAT-042 the per-agent read pointer is monotonic', function () {
    $room = PublicChatRoom::query()->create([
        'workspace_id' => $this->workspace->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'Somchai', 'provider_name' => 'Acme Co',
    ]);
    $user = User::factory()->create();

    expect(PublicChatRead::markRead($room->id, $user->id, $this->workspace->id, 5))->toBe(5)
        ->and(PublicChatRead::markRead($room->id, $user->id, $this->workspace->id, 9))->toBe(9)
        // a lower seq is a no-op, never a rewind
        ->and(PublicChatRead::markRead($room->id, $user->id, $this->workspace->id, 3))->toBe(9);

    expect(DB::table('public_chat_reads')->count())->toBe(1);
});

test('DEC-071 public chat ships disabled by default', function () {
    expect(SettingsService::DEFAULTS['publicchat.enabled'])->toBeFalse()
        ->and(app(SettingsService::class)->bool('publicchat.enabled'))->toBeFalse();
});

// =====================================================================
// HMAC MIDDLEWARE — FR-PCHAT-031
// =====================================================================

test('FR-PCHAT-031 (TC-PCHAT-001 middleware half) a correctly signed partner request is accepted and sets the workspace context', function () {
    pchatProbe(['customer_name' => 'สมชาย'], $this->key->key_id, $this->secret)
        ->assertOk()
        ->assertJson([
            'ok' => true,
            'key_id' => $this->key->key_id,
            'context_workspace_id' => $this->workspace->id,
        ]);
});

test('FR-PCHAT-031 (TC-PCHAT-008 middleware half) a valid signature still passes the middleware when the feature is off — the gate is the controller\'s job', function () {
    app(SettingsService::class)->set('publicchat.enabled', false);

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)->assertOk();
});

test('FR-PCHAT-031 a missing signature header is 401 API_KEY_INVALID, never AUTH_TOKEN_INVALID', function () {
    $this->postJson(PROBE_PATH, ['a' => 1])
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_KEY_INVALID');

    foreach (['X-PChat-Key', 'X-PChat-Timestamp', 'X-PChat-Nonce', 'X-PChat-Signature'] as $drop) {
        $raw = json_encode(['a' => 1]);
        $headers = pchatHeaders($this->key->key_id, $this->secret, 'POST', PROBE_PATH, $raw);
        unset($headers[$drop]);

        $this->call('POST', PROBE_PATH, [], [], [], collect($headers)
            ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])->all(), $raw)
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'API_KEY_INVALID');
    }
});

test('TC-PCHAT-002 a one-byte body tamper is 401 API_SIGNATURE_INVALID', function () {
    $raw = json_encode(['customer_name' => 'Somchai']);
    $headers = pchatHeaders($this->key->key_id, $this->secret, 'POST', PROBE_PATH, $raw);
    $tampered = json_encode(['customer_name' => 'Somchaj']);

    $this->call('POST', PROBE_PATH, [], [], [], collect($headers)
        ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])->all(), $tampered)
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_SIGNATURE_INVALID');
});

test('TC-PCHAT-007 a re-serialised, key-reordered body fails — the raw bytes are what is signed', function () {
    $raw = '{"b":2,"a":1}';
    $headers = pchatHeaders($this->key->key_id, $this->secret, 'POST', PROBE_PATH, $raw);

    // Same JSON value, different bytes. This is THE integration bug the docs warn about.
    $this->call('POST', PROBE_PATH, [], [], [], collect($headers)
        ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])->all(), '{"a":1,"b":2}')
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_SIGNATURE_INVALID');
});

test('TC-PCHAT-003 a timestamp outside the 300s window is 401 API_TIMESTAMP_SKEW', function () {
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['timestamp' => (string) (now()->getTimestamp() - 301)])
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_TIMESTAMP_SKEW')
        ->assertJsonPath('error.details.max_skew_seconds', 300);

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['timestamp' => (string) (now()->getTimestamp() + 301)])
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_TIMESTAMP_SKEW');

    // 299s is inside the window and must still verify.
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['timestamp' => (string) (now()->getTimestamp() - 299)])
        ->assertOk();
});

test('TC-PCHAT-004 replaying a nonce inside the window is 409 API_NONCE_REPLAYED', function () {
    $nonce = Str::random(24);

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['nonce' => $nonce])->assertOk();

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['nonce' => $nonce])
        ->assertStatus(409)
        ->assertJsonPath('error.code', 'API_NONCE_REPLAYED');
});

test('FR-PCHAT-031 an unknown key id is 401 API_KEY_INVALID', function () {
    pchatProbe(['a' => 1], PublicChatApiKey::generateKeyId(), $this->secret)
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_KEY_INVALID');
});

test('TC-PCHAT-005 a revoked key is 401 API_KEY_INVALID', function () {
    $this->key->forceFill(['revoked_at' => now()])->saveQuietly();

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_KEY_INVALID');
});

test('FR-PCHAT-031 a key belonging to an archived workspace is 401 API_KEY_INVALID', function () {
    $this->workspace->forceFill(['status' => WorkspaceStatus::Archived])->saveQuietly();

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_KEY_INVALID');
});

test('TC-PCHAT-038 an undecryptable secret is 401 API_KEY_INVALID plus a critical log, never a 500', function () {
    // spy(), not shouldReceive(): the framework's exception reporter also logs
    // through this manager, and a strict mock would fail on that unrelated call.
    Log::spy();

    // What an APP_KEY rotation leaves behind.
    $this->key->forceFill(['secret_ciphertext' => 'not-a-valid-laravel-ciphertext'])->saveQuietly();

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'API_KEY_INVALID');

    Log::shouldHaveReceived('critical')->once()
        ->withArgs(fn (string $message, array $ctx) => $message === 'public_chat.api_key_undecryptable'
            && $ctx['key_id'] === $this->key->key_id
            // the ciphertext must never reach a log line
            && ! array_key_exists('secret_ciphertext', $ctx));
});

test('TC-PCHAT-050 verification order: skew before key lookup, and a bad signature never burns a nonce', function () {
    // Step 2 runs before step 3 — an unknown key with a stale clock reports the skew.
    pchatProbe(['a' => 1], PublicChatApiKey::generateKeyId(), $this->secret, [
        'timestamp' => (string) (now()->getTimestamp() - 400),
    ])->assertStatus(401)->assertJsonPath('error.code', 'API_TIMESTAMP_SKEW');

    // Step 4 runs before step 5: a forged request must not be able to
    // pre-consume a legitimate client's nonce and turn its real request into 409.
    $nonce = Str::random(24);
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, [
        'nonce' => $nonce,
        'signature' => 'v1='.str_repeat('0', 64),
    ])->assertStatus(401)->assertJsonPath('error.code', 'API_SIGNATURE_INVALID');

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, ['nonce' => $nonce])->assertOk();
});

test('TC-PCHAT-037 last_used_at is written at most once a minute', function () {
    expect($this->key->fresh()->last_used_at)->toBeNull();

    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)->assertOk();
    $first = $this->key->fresh()->last_used_at;
    expect($first)->not->toBeNull();

    // A second call seconds later must not produce a second UPDATE.
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)->assertOk();
    expect($this->key->fresh()->last_used_at->equalTo($first))->toBeTrue();

    // Once the minute has elapsed it is refreshed.
    $this->key->forceFill(['last_used_at' => now()->subMinutes(2)])->saveQuietly();
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret)->assertOk();
    expect($this->key->fresh()->last_used_at->greaterThan(now()->subMinute()))->toBeTrue();
});

test('FR-PCHAT-031 the signed path includes the /api/v1 prefix and excludes the query string', function () {
    $raw = json_encode(['a' => 1]);
    // Signed over the bare path; sent with a query string appended.
    $headers = collect(pchatHeaders($this->key->key_id, $this->secret, 'POST', PROBE_PATH, $raw))
        ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])->all();

    $this->call('POST', PROBE_PATH.'?trace=1', [], [], [], $headers, $raw)->assertOk();

    // Signing a path without the /api/v1 prefix must fail.
    $bad = collect(pchatHeaders($this->key->key_id, $this->secret, 'POST', '/partner/public-chat/_foundation_probe', $raw))
        ->mapWithKeys(fn ($v, $k) => ['HTTP_'.str_replace('-', '_', strtoupper($k)) => $v])->all();

    $this->call('POST', PROBE_PATH, [], [], [], $bad, $raw)
        ->assertStatus(401)->assertJsonPath('error.code', 'API_SIGNATURE_INVALID');
});

test('FR-PCHAT-031 malformed credential envelopes are rejected before anything is looked up', function () {
    foreach ([
        ['key' => 'pck_nothex'],
        ['key' => 'notaprefix_'.str_repeat('a', 20)],
        ['timestamp' => 'not-a-number'],
        ['nonce' => 'short'],
        ['nonce' => str_repeat('a', 65)],
        ['nonce' => str_repeat('a', 12).'!!!!'],   // outside [A-Za-z0-9_-]
    ] as $override) {
        pchatProbe(['a' => 1], $this->key->key_id, $this->secret, $override)
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'API_KEY_INVALID');
    }
});

test('DEC-067 PCHAT_DISABLED renders 503 with Retry-After and a retry hint', function () {
    pchatProbe(['a' => 1], $this->key->key_id, $this->secret, [], PROBE_PATH.'_disabled')
        ->assertStatus(503)
        ->assertHeader('Retry-After', '60')
        ->assertJsonPath('error.code', 'PCHAT_DISABLED')
        ->assertJsonPath('error.details.retry_after_seconds', 60);
});

test('DEC-070 the public chat models keep WorkspaceScope, which is protective when a context is set', function () {
    $other = Workspace::factory()->create();
    $mine = PublicChatRoom::query()->create([
        'workspace_id' => $this->workspace->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'Mine', 'provider_name' => 'Acme Co',
    ]);
    $theirs = PublicChatRoom::query()->create([
        'workspace_id' => $other->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'Theirs', 'provider_name' => 'Acme Co',
    ]);

    app(WorkspaceContext::class)->set($this->workspace, null);

    expect(PublicChatRoom::query()->pluck('id')->all())->toBe([$mine->id]);
    expect(PublicChatRoom::query()->find($theirs->id))->toBeNull();

    // ...and INERT with no context, which is why Tier 1/2 must filter explicitly.
    app(WorkspaceContext::class)->clear();
    expect(PublicChatRoom::query()->count())->toBe(2);
    expect(PublicChatRoom::query()->where('workspace_id', $this->workspace->id)->count())->toBe(1);
});

test('FR-PCHAT-002 sender kinds and message types are exactly the specced sets', function () {
    expect(PublicChatSenderKind::values())->toBe(['visitor', 'agent', 'system'])
        ->and(PublicChatStatus::values())->toBe(['new', 'in_progress', 'done', 'problem'])
        ->and(PublicChatMessageType::values())->toBe(['text', 'image', 'video', 'file', 'system'])
        // no call/meet type exists in this bounded context and none ever should
        ->and(PublicChatMessageType::values())->not->toContain('call');
});
