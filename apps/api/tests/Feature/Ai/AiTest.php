<?php

use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\MemoryExtractionParser;
use App\Domain\Ai\TokenEstimator;
use App\Events\AiEvent;
use App\Jobs\CompactConversation;
use App\Jobs\ExtractMemories;
use App\Jobs\GenerateAiReply;
use App\Jobs\GenerateTitle;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUsageDaily;
use App\Models\AiUserMemory;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;

/**
 * FR-AI-001..008, 010 — AI Assistant feature slice
 * (API-100..113/117/118, TC-AI-001..006, 007..013, 014..036 subset,
 * 081..088 subset, 073..075 subset).
 */
beforeEach(function () {
    config(['ai.retry_backoff' => false]);
    app(SettingsService::class)->set('ai.stream.flush_interval_ms', 0);

    $this->tony = User::factory()->create(['username' => 'tony', 'ai_consented_at' => now()]);
    $this->somchai = User::factory()->create(['username' => 'somchai']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);

    $this->provider = aiProviderRow();

    [, $this->tonyToken] = loginAs($this->tony);
    [, $this->somchaiToken] = loginAs($this->somchai);
});

function aiProviderRow(array $override = []): AiProvider
{
    return AiProvider::create(array_merge([
        'name' => 'Z.AI GLM '.Str::ulid(),
        'provider_type' => 'openai_compatible',
        'base_url' => 'https://ai.test/v1',
        'api_key_encrypted' => Crypt::encryptString('sk-test'),
        'api_key_last4' => 'test',
        'model' => 'glm-5.2',
        'model_source' => 'custom',
        'window_size' => 200000,
        'max_output_tokens' => 4096,
        'temperature' => 0.7,
        'system_prompt' => 'คุณคือผู้ช่วยขององค์กร ตอบภาษาไทยกระชับ',
        'is_enabled' => true,
        'is_default' => true,
    ], $override));
}

function sseBody(array $deltas, ?array $usage = null, string $finish = 'stop'): string
{
    $lines = [];
    foreach ($deltas as $delta) {
        $lines[] = 'data: '.json_encode(['choices' => [['delta' => ['content' => $delta]]]], JSON_UNESCAPED_UNICODE);
    }
    $final = ['choices' => [['delta' => new stdClass, 'finish_reason' => $finish]]];
    if ($usage !== null) {
        $final['usage'] = $usage;
    }
    $lines[] = 'data: '.json_encode($final, JSON_UNESCAPED_UNICODE);
    $lines[] = 'data: [DONE]';

    return implode("\n\n", $lines)."\n\n";
}

/** stream → SSE, non-stream → plain chat JSON with the given reply content */
function fakeAiProvider(?string $chatReply = null, ?string $streamBody = null): void
{
    Http::fake(['*/chat/completions' => function ($request) use ($chatReply, $streamBody) {
        if (str_contains((string) $request->body(), '"stream":true')) {
            return Http::response($streamBody ?? sseBody(['สวัสดี', 'ครับ'], ['prompt_tokens' => 42, 'completion_tokens' => 7]), 200, ['Content-Type' => 'text/event-stream']);
        }

        return Http::response(['choices' => [['message' => ['content' => $chatReply ?? 'ตกลงครับ']]]]);
    }]);
}

function makeConversation($test, ?User $user = null, array $override = []): AiConversation
{
    return AiConversation::create(array_merge([
        'user_id' => ($user ?? $test->tony)->id,
        'last_message_at' => now(),
    ], $override));
}

// ---- FR-AI-001 gate + status (TC-AI-001..006) ----

test('TC-AI-001 status reports provider, limits and usage', function () {
    AiUsageDaily::bump($this->tony->id, $this->ws->id, messages: 3, tokensIn: 100, tokensOut: 50);

    $this->getJson('/api/v1/ai/status', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.enabled', true)
        ->assertJsonPath('data.configured', true)
        ->assertJsonPath('data.allowed_in_workspace', true)
        ->assertJsonPath('data.provider.model', 'glm-5.2')
        ->assertJsonPath('data.limits.daily_messages', 200)
        ->assertJsonPath('data.memory_enabled', true)
        ->assertJsonPath('data.consented', true)
        ->assertJsonPath('data.usage_today.messages', 3)
        ->assertJsonPath('data.usage_today.tokens', 150);
});

test('TC-AI-002 ai.enabled=false → 403 AI_DISABLED everywhere', function () {
    app(SettingsService::class)->set('ai.enabled', false);

    $this->getJson('/api/v1/ai/status', wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'AI_DISABLED');

    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'AI_DISABLED');

    app(SettingsService::class)->set('ai.enabled', true);
});

test('TC-AI-003 workspace not in allowed list → 403 AI_WORKSPACE_NOT_ALLOWED; null = all', function () {
    $this->provider->forceFill(['allowed_workspace_ids' => ['01J00000000000000000000000']])->save();

    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'AI_WORKSPACE_NOT_ALLOWED');

    // null reverts to all workspaces
    $this->provider->forceFill(['allowed_workspace_ids' => null])->save();
    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))->assertOk();
});

test('TC-AI-004 no default provider → 503 AI_PROVIDER_NOT_CONFIGURED', function () {
    $this->provider->delete();

    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(503)->assertJsonPath('error.code', 'AI_PROVIDER_NOT_CONFIGURED');
});

test('TC-AI-005/006 consent gate: status passes, send 403 until consent', function () {
    fakeAiProvider();

    $this->getJson('/api/v1/ai/status', wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()->assertJsonPath('data.consented', false);

    $conversation = makeConversation($this, $this->somchai);
    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'hi',
    ], wsHeaders($this->somchaiToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'AI_CONSENT_REQUIRED');

    $this->postJson('/api/v1/ai/consent', [], authHeaders($this->somchaiToken))->assertStatus(204);
    expect($this->somchai->refresh()->ai_consented_at)->not->toBeNull();

    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'hi',
    ], wsHeaders($this->somchaiToken, 'acme'))->assertStatus(202);
});

// ---- FR-AI-002 conversations (TC-AI-007..013) ----

test('TC-AI-007..013 conversation CRUD + ownership isolation', function () {
    $this->postJson('/api/v1/ai/conversations', ['title' => 'แผน deploy'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(201)->assertJsonPath('data.conversation.title', 'แผน deploy');
    $id = AiConversation::query()->where('user_id', $this->tony->id)->first()->id;

    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonCount(1, 'data');

    $this->patchJson("/api/v1/ai/conversations/{$id}", ['archived' => true], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonPath('data.conversation.archived_at', fn ($v) => $v !== null);

    // archived list only
    $this->getJson('/api/v1/ai/conversations?archived=1', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonCount(1, 'data');
    $this->getJson('/api/v1/ai/conversations', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonCount(0, 'data');

    // other user always 404 (never 403)
    $this->getJson("/api/v1/ai/conversations/{$id}", wsHeaders($this->somchaiToken, 'acme'))->assertStatus(404);
    $this->deleteJson("/api/v1/ai/conversations/{$id}", [], wsHeaders($this->somchaiToken, 'acme'))->assertStatus(404);

    $this->deleteJson("/api/v1/ai/conversations/{$id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);
    expect(AiConversation::query()->whereKey($id)->value('purge_after'))->not->toBeNull();
    $this->getJson("/api/v1/ai/conversations/{$id}", wsHeaders($this->tonyToken, 'acme'))->assertStatus(404);
});

// ---- FR-AI-003 send + stream + failure (TC-AI-014..032 subset) ----

test('TC-AI-014/015 send returns the pair; job completes with streamed content + usage', function () {
    fakeAiProvider();

    $conversation = makeConversation($this);

    $res = $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'สวัสดี AI',
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(202);

    $assistantId = $res->json('data.assistant_message.id');
    $assistant = AiMessage::query()->findOrFail($assistantId);

    // sync queue ran the job inline during terminate: completed with streamed text
    expect($assistant->status)->toBe('completed')
        ->and($assistant->content)->toBe('สวัสดีครับ')
        ->and($assistant->finish_reason)->toBe('stop')
        ->and($assistant->tokens_prompt)->toBe(42)
        ->and($assistant->tokens_source)->toBe('provider');

    $conversation->refresh();
    expect($conversation->message_count)->toBe(2)
        ->and($conversation->total_tokens_in)->toBe(42)
        ->and($conversation->token_ratio)->not->toBeNull();

    // request shape reaching the provider: system prompt first, stream + usage flags on
    Http::assertSent(function ($request) {
        $body = $request->data();

        return str_contains($request->url(), '/chat/completions')
            && $body['messages'][0]['role'] === 'system'
            && str_contains($body['messages'][0]['content'], 'ผู้ช่วยขององค์กร')
            && $body['stream'] === true
            && ($body['stream_options']['include_usage'] ?? null) === true;
    });
});

test('TC-AI-016 duplicate client_message_id replays the same pair', function () {
    fakeAiProvider();

    $conversation = makeConversation($this);
    $cmid = (string) Str::uuid();

    $first = $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => $cmid, 'content' => 'สวัสดี AI',
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(202)->json();

    $second = $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => $cmid, 'content' => 'สวัสดี AI',
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(200)->json();

    expect($second['data']['user_message']['id'])->toBe($first['data']['user_message']['id'])
        ->and($second['data']['assistant_message']['id'])->toBe($first['data']['assistant_message']['id']);

    // only one pair exists
    expect(AiMessage::query()->where('conversation_id', $conversation->id)->count())->toBe(2);
});

test('TC-AI-017 in-flight generation in the conversation → 409', function () {
    fakeAiProvider();

    $conversation = makeConversation($this);
    AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant',
        'status' => 'streaming',
    ]);

    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'again',
    ], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(409)->assertJsonPath('error.code', 'AI_GENERATION_IN_PROGRESS');
});

test('user-level concurrency cap → 409 across conversations', function () {
    app(SettingsService::class)->set('ai.max_concurrent_per_user', 1);

    $other = makeConversation($this);
    AiMessage::create([
        'conversation_id' => $other->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant',
        'status' => 'streaming',
    ]);

    $conversation = makeConversation($this);
    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'parallel?',
    ], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(409)->assertJsonPath('error.code', 'AI_GENERATION_IN_PROGRESS');
});

test('TC-AI-044 message over half the budget → 422 AI_MESSAGE_TOO_LONG', function () {
    fakeAiProvider();

    $conversation = makeConversation($this);

    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => str_repeat('ท', 40000),
    ], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422)->assertJsonPath('error.code', 'AI_MESSAGE_TOO_LONG');
});

test('TC-AI-081 daily quota exceeded → 429 with resets_at', function () {
    fakeAiProvider();

    AiUsageDaily::bump($this->tony->id, $this->ws->id, messages: 200);

    $conversation = makeConversation($this);
    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'เกินโควตา',
    ], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(429)
        ->assertJsonPath('error.code', 'AI_QUOTA_EXCEEDED')
        ->assertJsonStructure(['error' => ['details' => ['resets_at']]]);
});

test('TC-AI-024 provider 5xx → failed AI_PROVIDER_ERROR + ai.message.failed', function () {
    Event::fake([AiEvent::class]);
    Http::fake(['*/chat/completions' => Http::response(['error' => 'boom'], 500)]);

    $conversation = makeConversation($this);
    $res = $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'พังซะ',
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(202);

    $assistant = AiMessage::query()->findOrFail($res->json('data.assistant_message.id'));

    expect($assistant->status)->toBe('failed')
        ->and($assistant->error_code)->toBe('AI_PROVIDER_ERROR');

    Event::assertDispatched(AiEvent::class, fn (AiEvent $e) => $e->name === 'ai.message.failed');
    expect(AiUsageDaily::messagesToday($this->tony->id, 'UTC'))->toBe(1); // quota counts attempts (FR-AI-010)
});

test('TC-AI-018..020 delta events carry sequential indexes', function () {
    Event::fake([AiEvent::class]);
    fakeAiProvider();

    $conversation = makeConversation($this);
    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'สตรีมหน่อย',
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(202);

    $deltas = collect(Event::dispatched(AiEvent::class))->flatten()
        ->filter(fn (AiEvent $e) => $e->name === 'ai.message.delta')
        ->map(fn (AiEvent $e) => $e->data['index'])
        ->values();

    expect($deltas->all())->not->toBeEmpty()->toEqual(range(0, $deltas->count() - 1));

    Event::assertDispatched(AiEvent::class, fn (AiEvent $e) => $e->name === 'ai.message.started');
    Event::assertDispatched(AiEvent::class, fn (AiEvent $e) => $e->name === 'ai.message.completed'
        && $e->data['message']['status'] === 'completed');
});

// ---- FR-AI-004 cancel (TC-AI-033..036) ----

test('TC-AI-033/034 cancel: flag set for generating, 409 when finished', function () {
    fakeAiProvider();

    $conversation = makeConversation($this);
    $message = AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant',
        'status' => 'streaming',
    ]);

    $this->postJson("/api/v1/ai/messages/{$message->id}/cancel", [], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonPath('data.message.status', 'streaming');
    expect(Redis::exists("ai:cancel:{$message->id}"))->toBe(1);

    // job honors the flag at the next delta (flag already set → stops before the first)
    (new GenerateAiReply($message->id))->handle(app(ContextBuilder::class), app(TokenEstimator::class), app(SettingsService::class));
    expect($message->refresh()->status)->toBe('cancelled')
        ->and($message->refresh()->finish_reason)->toBe('cancelled')
        ->and(Redis::exists("ai:cancel:{$message->id}"))->toBe(0); // cleared after finalize

    // cancelling a finished message
    $this->postJson("/api/v1/ai/messages/{$message->id}/cancel", [], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(409)->assertJsonPath('error.code', 'AI_NOT_GENERATING');
});

// ---- API-117 partial stream reads ----

test('API-117 message show serves partial content + last_index while live', function () {
    $conversation = makeConversation($this);
    $message = AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant',
        'status' => 'streaming',
    ]);
    Redis::rPush("ai:gen:{$message->id}", 'สวัสดี');
    Redis::rPush("ai:gen:{$message->id}", 'ครับ');

    $this->getJson("/api/v1/ai/messages/{$message->id}", authHeaders($this->tonyToken))
        ->assertOk()
        ->assertJsonPath('data.partial_content', 'สวัสดีครับ')
        ->assertJsonPath('data.last_index', 1)
        ->assertJsonPath('data.message.content', null);

    Redis::del("ai:gen:{$message->id}");
});

// ---- API-118 focus ----

test('API-118 focus toggles the push-suppression key', function () {
    $conversation = makeConversation($this);
    $key = "ai:focus:{$conversation->id}:{$this->tony->id}";

    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/focus", ['focused' => true], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(204);
    expect(Redis::exists($key))->toBe(1);

    $this->postJson("/api/v1/ai/conversations/{$conversation->id}/focus", ['focused' => false], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(204);
    expect(Redis::exists($key))->toBe(0);
});

// ---- FR-AI-006/007 memories (TC-AI-051..072 subset) ----

test('TC-AI-067..072 memory list, manual add, delete, clear', function () {
    $mine = AiUserMemory::create(['user_id' => $this->tony->id, 'content' => 'ชอบคำตอบสั้น', 'category' => 'preference', 'importance' => 4]);
    AiUserMemory::create(['user_id' => $this->somchai->id, 'content' => 'ของคนอื่น', 'category' => 'other']);

    $this->getJson('/api/v1/ai/memories', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonCount(1, 'data.memories')
        ->assertJsonPath('data.memories.0.content', 'ชอบคำตอบสั้น');

    $this->getJson('/api/v1/ai/memories?category=profile', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->assertJsonCount(0, 'data.memories');

    $this->postJson('/api/v1/ai/memories', ['content' => 'ทำงานทีม Platform', 'category' => 'project'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(201)->assertJsonPath('data.memory.source', 'user');

    $this->deleteJson("/api/v1/ai/memories/{$mine->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);
    expect(AiUserMemory::query()->whereKey($mine->id)->exists())->toBeFalse(); // hard delete

    $this->postJson('/api/v1/ai/memories/clear', [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);
    expect(AiUserMemory::query()->where('user_id', $this->tony->id)->count())->toBe(0);
    expect(AiUserMemory::query()->where('user_id', $this->somchai->id)->count())->toBe(1); // others untouched
});

test('TC-AI-056 ExtractMemories applies add/update/delete with trgm dedupe', function () {
    $conversation = makeConversation($this);
    $toDelete = AiUserMemory::create(['user_id' => $this->tony->id, 'content' => 'outdated fact about the old project', 'category' => 'other', 'importance' => 2]);
    $nearDup = AiUserMemory::create(['user_id' => $this->tony->id, 'content' => 'I work on the payments team', 'category' => 'project', 'importance' => 4]);

    AiMessage::create(['conversation_id' => $conversation->id, 'user_id' => $this->tony->id, 'seq' => 1, 'role' => 'user', 'content' => 'I work on the payments team now', 'status' => 'completed']);
    AiMessage::create(['conversation_id' => $conversation->id, 'user_id' => $this->tony->id, 'seq' => 2, 'role' => 'assistant', 'content' => 'noted!', 'status' => 'completed']);

    $reply = json_encode([
        'add' => [
            ['content' => 'I work on the payments team', 'category' => 'project', 'importance' => 4], // ≥0.85 dup → update
            ['content' => 'ชื่อเล่น โทนี่', 'category' => 'profile', 'importance' => 5],              // new
        ],
        'update' => [],
        'delete' => [$toDelete->id],
    ], JSON_UNESCAPED_UNICODE);
    fakeAiProvider(chatReply: $reply);

    (new ExtractMemories($conversation->id, 'msg'))->handle(app(MemoryExtractionParser::class), app(SettingsService::class));

    expect(AiUserMemory::query()->whereKey($toDelete->id)->exists())->toBeFalse()
        ->and(AiUserMemory::query()->where('user_id', $this->tony->id)->where('content', 'ชื่อเล่น โทนี่')->exists())->toBeTrue()
        // the near-duplicate merged instead of adding a second row
        ->and(AiUserMemory::query()->where('user_id', $this->tony->id)->whereRaw("content LIKE '%payments%'")->count())->toBe(1);
});

test('TC-AI-058 memory off → extraction is a no-op and rows survive', function () {
    $this->tony->forceFill(['ai_memory_enabled' => false])->save();

    $conversation = makeConversation($this);
    AiMessage::create(['conversation_id' => $conversation->id, 'user_id' => $this->tony->id, 'seq' => 1, 'role' => 'user', 'content' => 'x', 'status' => 'completed']);
    AiUserMemory::create(['user_id' => $this->tony->id, 'content' => 'เดิมอยู่', 'category' => 'other']);

    fakeAiProvider(chatReply: json_encode(['add' => [['content' => 'ใหม่', 'category' => 'other', 'importance' => 3]]]));

    (new ExtractMemories($conversation->id, 'msg'))->handle(app(MemoryExtractionParser::class), app(SettingsService::class));

    expect(AiUserMemory::query()->where('user_id', $this->tony->id)->count())->toBe(1)
        ->and(AiUserMemory::query()->where('user_id', $this->tony->id)->where('content', 'ใหม่')->exists())->toBeFalse();
});

// ---- FR-AI-005/008 compaction + title (TC-AI-045/073 subset) ----

test('TC-AI-045 CompactConversation folds the older half into the summary', function () {
    fakeAiProvider(chatReply: "- ผู้ใช้ทำระบบแชท\n- ต้อง deploy วันศุกร์");

    $conversation = makeConversation($this, override: ['summary' => 'เดิม', 'summary_up_to_seq' => 0]);
    foreach (range(1, 4) as $i) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
            'seq' => $i, 'role' => $i % 2 ? 'user' : 'assistant', 'content' => "ข้อความที่ {$i}", 'status' => 'completed',
        ]);
    }

    (new CompactConversation($conversation->id))->handle(app(ContextBuilder::class), app(TokenEstimator::class));

    $conversation->refresh();
    expect($conversation->summary)->toContain('deploy')
        ->and($conversation->summary_up_to_seq)->toBe(2)
        ->and($conversation->summary_tokens)->toBeGreaterThan(0);
});

test('TC-AI-073 GenerateTitle sets a short auto title once', function () {
    fakeAiProvider(chatReply: 'แผนการ deploy วันศุกร์');

    $conversation = makeConversation($this, override: ['message_count' => 2]);
    AiMessage::create(['conversation_id' => $conversation->id, 'user_id' => $this->tony->id, 'seq' => 1, 'role' => 'user', 'content' => 'ช่วยวางแผน deploy วันศุกร์', 'status' => 'completed']);

    (new GenerateTitle($conversation->id))->handle();

    expect($conversation->refresh()->title)->toBe('แผนการ deploy วันศุกร์')
        ->and($conversation->title_source)->toBe('auto');

    // user-set title is never overwritten
    $conversation->forceFill(['title' => 'ชื่อของฉัน', 'title_source' => 'user'])->save();
    fakeAiProvider(chatReply: 'ห้ามเปลี่ยน');
    (new GenerateTitle($conversation->id))->handle();
    expect($conversation->refresh()->title)->toBe('ชื่อของฉัน');
});
