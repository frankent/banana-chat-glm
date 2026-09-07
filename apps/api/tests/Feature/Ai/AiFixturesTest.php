<?php

use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\MemoryExtractionParser;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\SseParser;
use App\Domain\Ai\TokenEstimator;
use App\Events\AiEvent;
use App\Jobs\CompactConversation;
use App\Jobs\ExtractMemories;
use App\Jobs\GenerateAiReply;
use App\Jobs\GenerateTitle;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUserMemory;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;

/**
 * TASK-QA-008 — fixture-driven AI tests.
 *
 * SSE bodies and provider error payloads come from tests/Fixtures/Ai/*
 * (real OpenAI-compatible shapes, not inline heredocs), TokenEstimator
 * drift is checked against values recorded live from the provider
 * (TC-AI-037), and the four provider-facing prompts are pinned by
 * snapshot files (TC-AI-060 — the extraction prompt must keep its
 * sensitive-data prohibitions).
 *
 * Refresh snapshots after an intentional prompt change:
 *   UPDATE_SNAPSHOTS=1 vendor/bin/pest tests/Feature/Ai/AiFixturesTest.php
 */
beforeEach(function () {
    config(['ai.retry_backoff' => false]);
    app(SettingsService::class)->set('ai.stream.flush_interval_ms', 0);

    $this->tony = User::factory()->create(['username' => 'tony', 'ai_consented_at' => now()]);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);

    $this->provider = AiProvider::create([
        'name' => 'Z.AI GLM',
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
    ]);
});

function aiFixture(string $rel): string
{
    return file_get_contents(__DIR__.'/../../Fixtures/Ai/'.$rel);
}

/**
 * Fake the provider endpoint while recording every request body on
 * $store->requests (object handle — safe across the closure boundary).
 */
function capturingFake($response): stdClass
{
    $store = new stdClass;
    $store->requests = [];

    Http::fake(['*/chat/completions' => function ($request) use ($store, $response) {
        $store->requests[] = ['url' => (string) $request->url(), 'body' => $request->data()];

        return $response;
    }]);

    return $store;
}

function sseResponse(string $rel)
{
    return Http::response(aiFixture('sse/'.$rel), 200, ['Content-Type' => 'text/event-stream']);
}

function expectSnapshot(string $name, array $actual): void
{
    $path = __DIR__.'/../../Fixtures/Ai/snapshots/'.$name;
    $json = json_encode($actual, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";

    if (getenv('UPDATE_SNAPSHOTS') === '1') {
        @mkdir(dirname($path), 0755, true);
        file_put_contents($path, $json);
        test()->markTestSkipped("snapshot {$name} rewritten — review the diff and re-run");

        return;
    }

    if (! file_exists($path)) {
        test()->fail("snapshot {$name} missing — run UPDATE_SNAPSHOTS=1 vendor/bin/pest tests/Feature/Ai/AiFixturesTest.php once to create it");
    }

    expect($json)->toBe(file_get_contents($path));
}

// ---- SSE fixtures (FR-AI-019 parser + provider stream path) ----

test('QA-008 SSE fixture: basic stream yields deltas, usage then done in order', function () {
    capturingFake(sseResponse('01-basic.sse'));

    $events = iterator_to_array(OpenAiCompatibleProvider::make()->chatStream([
        ['role' => 'user', 'content' => 'สวัสดี'],
    ]));

    expect($events)->toBe([
        ['type' => 'delta', 'text' => 'สวัสดี'],
        ['type' => 'delta', 'text' => 'ครับ'],
        ['type' => 'delta', 'text' => ' ผมช่วยอะไรได้'],
        ['type' => 'done', 'finish_reason' => 'stop'],
        ['type' => 'usage', 'usage' => ['prompt_tokens' => 42, 'completion_tokens' => 12]],
    ]);
});

test('QA-008 SSE fixture: comments, pings, CRLF endings and byte-split chunks', function () {
    $body = aiFixture('sse/02-comments-ping.sse');

    // CRLF transport variant must parse identically, even fed byte-wise
    $crlf = str_replace("\n", "\r\n", $body);
    $parser = new SseParser;
    $events = [];
    foreach (str_split($crlf, 7) as $chunk) { // hostile chunk boundaries mid-UTF-8
        $events = [...$events, ...$parser->push($chunk)];
    }

    expect(count($events))->toBe(3) // hello / world / finish+usage
        ->and($parser->isDone())->toBeTrue()
        ->and($events[0]['choices'][0]['delta']['content'])->toBe('hello')
        ->and($events[1]['choices'][0]['delta']['content'])->toBe(' world')
        ->and($events[2]['choices'][0]['finish_reason'])->toBe('stop');
});

test('QA-008 SSE fixture: error object mid-stream is inert at parser level', function () {
    capturingFake(sseResponse('03-error-mid-stream.sse'));

    $events = iterator_to_array(OpenAiCompatibleProvider::make()->chatStream([
        ['role' => 'user', 'content' => 'x'],
    ]));

    // partial delta survives; the error payload yields no event and the
    // stream still terminates cleanly on [DONE]
    expect($events)->toBe([['type' => 'delta', 'text' => 'บางส่วน']]);
});

test('QA-008 SSE fixture: stream ending without [DONE] → AI_PROVIDER_TIMEOUT', function () {
    capturingFake(sseResponse('04-truncated-no-done.sse'));

    $events = [];
    foreach (OpenAiCompatibleProvider::make()->chatStream([['role' => 'user', 'content' => 'x']]) as $event) {
        $events[] = $event;
    }
})->throws(AiProviderException::class, 'stream ended without [DONE]');

test('QA-008 SSE fixture: usage chunk before finish chunk', function () {
    capturingFake(sseResponse('05-usage-before-finish.sse'));

    $events = iterator_to_array(OpenAiCompatibleProvider::make()->chatStream([
        ['role' => 'user', 'content' => 'code หน่อย'],
    ]));

    expect($events)->toHaveCount(3)
        ->and($events[0])->toBe(['type' => 'delta', 'text' => "```php\necho 'hi';\n```"])
        ->and($events[1])->toBe(['type' => 'usage', 'usage' => ['prompt_tokens' => 100, 'completion_tokens' => 20]])
        ->and($events[2])->toBe(['type' => 'done', 'finish_reason' => 'length']);
});

// ---- provider HTTP error fixtures (FR-AI-019 error mapping) ----

test('QA-008 HTTP fixture: 401 invalid key → AI_PROVIDER_ERROR, no retry', function () {
    $store = capturingFake(Http::response(json_decode(aiFixture('http/401-invalid-key.json'), true), 401));

    try {
        OpenAiCompatibleProvider::make()->chat([['role' => 'user', 'content' => 'x']]);
        $this->fail('expected AiProviderException');
    } catch (AiProviderException $e) {
        expect($e->errorCode)->toBe('AI_PROVIDER_ERROR');
    }
    expect(count($store->requests))->toBe(1);
});

test('QA-008 HTTP fixture: 429 rate limit → 3 retries then AI_PROVIDER_ERROR', function () {
    $captured = [];
    Http::fake(['*/chat/completions' => function ($request) use (&$captured) {
        $captured[] = $request->data();

        return Http::response(json_decode(aiFixture('http/429-rate-limit.json'), true), 429, ['Retry-After' => '2']);
    }]);

    try {
        OpenAiCompatibleProvider::make()->chat([['role' => 'user', 'content' => 'x']]);
        $this->fail('expected AiProviderException');
    } catch (AiProviderException $e) {
        expect($e->errorCode)->toBe('AI_PROVIDER_ERROR');
    }
    expect(count($captured))->toBe(4); // 1 initial + 3 retries
});

test('QA-008 HTTP fixture: 5xx → 2 retries then AI_PROVIDER_ERROR', function () {
    $captured = [];
    Http::fake(['*/chat/completions' => function ($request) use (&$captured) {
        $captured[] = $request->data();

        return Http::response(json_decode(aiFixture('http/503-overloaded.json'), true), 503);
    }]);

    try {
        OpenAiCompatibleProvider::make()->chat([['role' => 'user', 'content' => 'x']]);
        $this->fail('expected AiProviderException');
    } catch (AiProviderException $e) {
        expect($e->errorCode)->toBe('AI_PROVIDER_ERROR');
    }
    expect(count($captured))->toBe(3); // 1 initial + 2 retries
});

test('QA-008 HTTP fixture: context_length 400 → AI_CONTEXT_OVERFLOW (no retry)', function () {
    $captured = [];
    Http::fake(['*/chat/completions' => function ($request) use (&$captured) {
        $captured[] = $request->data();

        return Http::response(json_decode(aiFixture('http/400-context-length.json'), true), 400);
    }]);

    try {
        OpenAiCompatibleProvider::make()->chat([['role' => 'user', 'content' => 'x']]);
        $this->fail('expected AiProviderException');
    } catch (AiProviderException $e) {
        expect($e->errorCode)->toBe('AI_CONTEXT_OVERFLOW');
    }
    expect(count($captured))->toBe(1);
});

test('QA-008 HTTP fixture: stream_options rejection → retried once without it', function () {
    $captured = [];
    Http::fake(['*/chat/completions' => function ($request) use (&$captured) {
        $captured[] = $request->data();

        // first attempt carries stream_options → provider rejects; second succeeds
        if (array_key_exists('stream_options', $request->data())) {
            return Http::response(json_decode(aiFixture('http/400-stream-options.json'), true), 400);
        }

        return sseResponse('01-basic.sse');
    }]);

    $events = iterator_to_array(OpenAiCompatibleProvider::make()->chatStream([['role' => 'user', 'content' => 'สวัสดี']]));

    expect(count($captured))->toBe(2)
        ->and(array_key_exists('stream_options', $captured[0]))->toBeTrue()
        ->and(array_key_exists('stream_options', $captured[1]))->toBeFalse()
        ->and($events)->toHaveCount(5); // the basic fixture's event set
});

// ---- TokenEstimator fixtures (TC-AI-037/038) ----

test('QA-008 TC-AI-037 estimator stays within ±15% of recorded provider values', function () {
    $fixture = json_decode(aiFixture('tokens.json'), true);
    $estimator = app(TokenEstimator::class);

    $checked = 0;
    foreach ($fixture['samples'] as $sample) {
        if ($sample['provider_prompt_tokens'] === null) {
            continue;
        }
        $checked++;
        $estimate = $estimator->estimate($sample['text']);
        $actual = $sample['provider_prompt_tokens'];
        $drift = abs($estimate - $actual) / max(1, $actual);

        // ±15% relative, or ≤12 tokens absolute — chat-template overhead
        // dominates very short samples
        expect($drift <= 0.15 || abs($estimate - $actual) <= 12)
            ->toBeTrue("sample {$sample['id']}: estimate {$estimate} vs provider {$actual}");
    }

    if ($checked === 0) {
        $this->markTestSkipped('no live provider values recorded yet — run `php artisan ai:tokens-fixtures` against the real provider (TASK-QA-008)');
    }
});

test('QA-008 TC-AI-037 estimator density: Thai tokenizes denser than English per char', function () {
    $fixture = json_decode(aiFixture('tokens.json'), true);
    $samples = collect($fixture['samples'])->keyBy('id');
    $estimator = app(TokenEstimator::class);

    $th = $estimator->estimate($samples['th-paragraph']['text']) / mb_strlen($samples['th-paragraph']['text']);
    $en = $estimator->estimate($samples['en-paragraph']['text']) / mb_strlen($samples['en-paragraph']['text']);

    expect($th)->toBeGreaterThan($en * 1.5);
});

test('QA-008 TC-AI-038 estimator scales by conversation token_ratio, EMA converges', function () {
    $fixture = json_decode(aiFixture('tokens.json'), true);
    $text = collect($fixture['samples'])->keyBy('id')['mixed-th-en']['text'];
    $estimator = app(TokenEstimator::class);

    $base = $estimator->estimate($text);
    expect($estimator->estimate($text, 2.0))->toBeGreaterThanOrEqual($base * 2)
        ->and($estimator->estimate($text, 0.5))->toBeLessThanOrEqual((int) ceil($base * 0.5));

    // first observation seeds the ratio; subsequent ones move it 30%
    $ratio = $estimator->nextRatio(null, $base, (int) round($base * 1.2));
    expect(abs($ratio - 1.2))->toBeLessThan(0.01);
    $first = $ratio;
    $ratio = $estimator->nextRatio($ratio, $base, (int) round($base * 2.0));
    expect(abs($ratio - (0.7 * $first + 0.3 * 2.0)))->toBeLessThan(0.01) // EMA blend
        ->and($ratio)->toBeGreaterThan($first)->toBeLessThan(2.0);
});

// ---- prompt snapshots (TC-AI-060) ----

function snapshotConversation($test): AiConversation
{
    $conversation = AiConversation::create([
        'user_id' => $test->tony->id,
        'last_message_at' => now(),
        'summary' => 'ผู้ใช้ทำระบบแชทอยู่ ต้อง deploy วันศุกร์',
        'summary_up_to_seq' => 0,
    ]);

    foreach ([
        [1, 'user', 'ช่วยวางแผน deploy วันศุกร์'],
        [2, 'assistant', 'เริ่มจาก migration ก่อนครับ'],
        [3, 'user', 'ok แล้ว staging ต้องทำไรบ้าง'],
        [4, 'assistant', 'รัน migration แล้ว smoke test ครับ'],
    ] as [$seq, $role, $content]) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $test->tony->id,
            'seq' => $seq, 'role' => $role, 'content' => $content, 'status' => 'completed',
        ]);
    }

    return $conversation;
}

function snapshotMemories($test): void
{
    foreach ([
        ['01ABCDEF000000000000000001', 'ชอบคำตอบสั้น กระชับ', 'preference', 5],
        ['01ABCDEF000000000000000002', 'ทำงานทีม Platform', 'project', 4],
    ] as [$id, $content, $category, $importance]) {
        $memory = new AiUserMemory([ // id set post-fill: not mass-assignable, and fixed so the roster snapshot is deterministic
            'user_id' => $test->tony->id, 'content' => $content,
            'category' => $category, 'importance' => $importance,
        ]);
        $memory->id = $id;
        $memory->save();
    }
}

test('QA-008 TC-AI-060 snapshot: reply context prompt (system + memories + summary + turns)', function () {
    snapshotMemories($this);
    $conversation = snapshotConversation($this);

    $messages = app(ContextBuilder::class)->build(
        $conversation,
        $this->provider,
        AiUserMemory::query()->active()->where('user_id', $this->tony->id)->orderBy('id')->get(),
    );

    expectSnapshot('reply-context.json', $messages);

    // invariants that must survive any prompt edit
    expect($messages[0]['role'])->toBe('system')
        ->and($messages[0]['content'])->toContain('## สิ่งที่รู้เกี่ยวกับผู้ใช้')
        ->toContain('## สรุปบทสนทนาก่อนหน้า')
        ->and(count($messages))->toBe(5); // system + 4 turns
});

test('QA-008 snapshot: full reply request body via GenerateAiReply', function () {
    Event::fake([AiEvent::class]);
    snapshotMemories($this);
    $conversation = snapshotConversation($this);

    $assistant = AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 5, 'role' => 'assistant', 'status' => 'pending',
    ]);

    $store = capturingFake(sseResponse('01-basic.sse'));

    (new GenerateAiReply($assistant->id))->handle(app(ContextBuilder::class), app(TokenEstimator::class), app(SettingsService::class));

    // reply stream + the sync-queued follow-ups (ExtractMemories, GenerateTitle)
    expect($store->requests)->toHaveCount(3);
    expect($store->requests[0]['body']['stream'])->toBeTrue();
    expectSnapshot('reply-request.json', $store->requests[0]['body']);
});

test('QA-008 TC-AI-060 snapshot: memory extraction prompt keeps sensitive-data prohibitions', function () {
    snapshotMemories($this);
    $conversation = snapshotConversation($this);

    $store = capturingFake(Http::response([
        'choices' => [['message' => ['content' => '{"add":[],"update":[],"delete":[]}']]],
    ]));

    (new ExtractMemories($conversation->id, 'msg'))->handle(app(MemoryExtractionParser::class), app(SettingsService::class));

    expect($store->requests)->toHaveCount(1);
    expectSnapshot('extract-memories-request.json', $store->requests[0]['body']);

    // TC-AI-060 — the prohibitions themselves, asserted independently of the file
    $system = $store->requests[0]['body']['messages'][0]['content'];
    expect($system)->toContain('รหัสผ่าน')->toContain('สุขภาพ')->toContain('JSON เท่านั้น');
});

test('QA-008 snapshot: title generation request', function () {
    $conversation = snapshotConversation($this);
    $conversation->forceFill(['message_count' => 5])->save();

    $store = capturingFake(Http::response([
        'choices' => [['message' => ['content' => 'แผน deploy วันศุกร์']]],
    ]));

    (new GenerateTitle($conversation->id))->handle();

    expect($store->requests)->toHaveCount(1);
    expectSnapshot('generate-title-request.json', $store->requests[0]['body']);
});

test('QA-008 snapshot: compaction request', function () {
    $conversation = snapshotConversation($this);

    $store = capturingFake(Http::response([
        'choices' => [['message' => ['content' => "- ทำระบบแชท\n- deploy ศุกร์"]]],
    ]));

    (new CompactConversation($conversation->id))->handle(app(ContextBuilder::class), app(TokenEstimator::class));

    expect($store->requests)->toHaveCount(1);
    expectSnapshot('compact-conversation-request.json', $store->requests[0]['body']);
});
