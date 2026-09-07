<?php

use App\Domain\Ai\AiCircuitBreaker;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\TokenEstimator;
use App\Events\AiEvent;
use App\Jobs\GenerateAiReply;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * NFR-OPS-011 / TASK-INF-014 — circuit breaker + alert rules.
 * (TC-AI-089..094 adjacency: provider health behavior.)
 */
beforeEach(function () {
    config(['ai.retry_backoff' => false]);
    app(SettingsService::class)->set('ai.stream.flush_interval_ms', 0);
    config(['ai.breaker.threshold' => 3, 'ai.breaker.open_seconds' => 60]); // small for tests

    $this->tony = User::factory()->create(['username' => 'tony', 'ai_consented_at' => now()]);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);

    $this->provider = AiProvider::create([
        'name' => 'Z.AI GLM '.Str::ulid(),
        'provider_type' => 'openai_compatible',
        'base_url' => 'https://ai.test/v1',
        'api_key_encrypted' => encrypt('sk-test'),
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

    [, $this->tonyToken] = loginAs($this->tony);

    AiCircuitBreaker::make()->reset();
});

function breakerConversation($test): AiConversation
{
    return AiConversation::create(['user_id' => $test->tony->id, 'last_message_at' => now()]);
}

test('NFR-OPS-011 breaker opens after consecutive provider failures and send gets 503', function () {
    Http::fake(['*/chat/completions' => Http::response(['error' => 'down'], 500)]);
    Event::fake([AiEvent::class]);

    // threshold = 3 consecutive failures
    foreach (range(1, 3) as $i) {
        $conversation = breakerConversation($this);
        $message = AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
            'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant', 'status' => 'pending',
        ]);
        (new GenerateAiReply($message->id))->handle(
            app(ContextBuilder::class), app(TokenEstimator::class), app(SettingsService::class));
    }

    $breaker = AiCircuitBreaker::make();
    expect($breaker->isOpen())->toBeTrue()
        ->and($breaker->openRemaining())->toBeGreaterThan(0)
        ->and($breaker->openRemaining())->toBeLessThanOrEqual(60);

    // send while open → immediate 503 AI_PROVIDER_ERROR, no new pair
    $fresh = breakerConversation($this);
    $this->postJson("/api/v1/ai/conversations/{$fresh->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'content' => 'ยังส่งได้ไหม',
    ], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(503)
        ->assertJsonPath('error.code', 'AI_PROVIDER_ERROR')
        ->assertJsonStructure(['error' => ['details' => ['retry_after_seconds']]]);
    expect(AiMessage::query()->where('conversation_id', $fresh->id)->count())->toBe(0);
});

test('NFR-OPS-011 breaker counts only provider errors, not context overflow', function () {
    $breaker = AiCircuitBreaker::make();
    $breaker->recordFailure('AI_CONTEXT_OVERFLOW');
    $breaker->recordFailure('AI_PROVIDER_TIMEOUT');
    $breaker->recordFailure('AI_PROVIDER_TIMEOUT');
    expect($breaker->isOpen())->toBeFalse(); // 2 of threshold 3

    $breaker->recordFailure('AI_PROVIDER_ERROR');
    expect($breaker->isOpen())->toBeTrue();
});

test('NFR-OPS-011 breaker auto-closes after the open window', function () {
    // real Redis TTLs don't follow Carbon travel — use a 1s window
    $breaker = new AiCircuitBreaker(3, 1);
    foreach (range(1, 3) as $i) {
        $breaker->recordFailure('AI_PROVIDER_ERROR');
    }
    expect($breaker->isOpen())->toBeTrue();

    usleep(1100000);
    expect($breaker->isOpen())->toBeFalse(); // TTL expired → half-open
});

test('NFR-OPS-011 successful generation resets the failure counter', function () {
    Http::fake(['*/chat/completions' => function ($request) {
        if (str_contains((string) $request->body(), '"stream":true')) {
            $lines = collect(['สวัสดี', 'ครับ'])
                ->map(fn ($d) => 'data: '.json_encode(['choices' => [['delta' => ['content' => $d]]]]))
                ->push('data: '.json_encode(['choices' => [['delta' => new stdClass, 'finish_reason' => 'stop']], 'usage' => ['prompt_tokens' => 5, 'completion_tokens' => 2]]))
                ->push('data: [DONE]');

            return Http::response($lines->implode("\n\n")."\n\n", 200, ['Content-Type' => 'text/event-stream']);
        }

        return Http::response(['choices' => [['message' => ['content' => 'ok']]]]);
    }]);
    Event::fake([AiEvent::class]);

    $breaker = AiCircuitBreaker::make();
    $breaker->recordFailure('AI_PROVIDER_ERROR');
    $breaker->recordFailure('AI_PROVIDER_ERROR'); // 2 of threshold 3

    $conversation = breakerConversation($this);
    $message = AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id, 'seq' => 2, 'role' => 'assistant', 'status' => 'pending',
    ]);
    (new GenerateAiReply($message->id))->handle(
        app(ContextBuilder::class), app(TokenEstimator::class), app(SettingsService::class));

    expect($message->refresh()->status)->toBe('completed');

    // success cleared the counter: two more failures are only 2 consecutive → still closed
    $breaker->recordFailure('AI_PROVIDER_ERROR');
    $breaker->recordFailure('AI_PROVIDER_ERROR');
    expect($breaker->isOpen())->toBeFalse();
});

/** Capture Log::warning calls into $captured without Log::spy quirks. */
function captureWarnings(array &$captured): void
{
    $captured = [];
    Log::shouldReceive('warning')->zeroOrMoreTimes()->andReturnUsing(function ($msg, $ctx = null) use (&$captured) {
        $captured[] = [$msg, is_array($ctx) ? $ctx : []];

        return null;
    });
}

test('NFR-OPS-011 alert command fires on error rate over the window', function () {
    config(['ai.alerts.min_attempts' => 5]);
    $captured = [];
    captureWarnings($captured);

    $conversation = breakerConversation($this);
    $seq = 0;
    // 4 failed + 1 completed = 80% error rate over 5 attempts
    foreach ([['failed', null], ['failed', null], ['failed', null], ['failed', null], ['completed', 100]] as [$status, $ttft]) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
            'workspace_id' => $this->ws->id, 'seq' => ++$seq, 'role' => 'assistant',
            'status' => $status, 'latency_first_token_ms' => $ttft, 'updated_at' => now(),
        ]);
    }

    $this->artisan('ai:check-alerts')->assertSuccessful();

    expect($captured)->toHaveCount(1)
        ->and($captured[0][0])->toBe('ai.provider_error_rate_alert')
        ->and($captured[0][1]['failed'])->toBe(4)
        ->and($captured[0][1]['attempts'])->toBe(5);
});

test('NFR-OPS-011 alert command is quiet on a healthy window', function () {
    $captured = [];
    captureWarnings($captured);

    $conversation = breakerConversation($this);
    foreach (range(1, 5) as $i) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
            'workspace_id' => $this->ws->id, 'seq' => $i, 'role' => 'assistant',
            'status' => 'completed', 'latency_first_token_ms' => 90, 'updated_at' => now(),
        ]);
    }

    $this->artisan('ai:check-alerts')->assertSuccessful();
    expect($captured)->toBeEmpty();
});

test('NFR-OPS-011 alert command fires on slow first token p95', function () {
    $captured = [];
    captureWarnings($captured);

    $conversation = breakerConversation($this);
    foreach (range(1, 10) as $i) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $this->tony->id,
            'workspace_id' => $this->ws->id, 'seq' => $i, 'role' => 'assistant',
            'status' => 'completed', 'latency_first_token_ms' => 20000, 'updated_at' => now(),
        ]);
    }

    $this->artisan('ai:check-alerts')->assertSuccessful();

    expect($captured)->toHaveCount(1)
        ->and($captured[0][0])->toBe('ai.first_token_p95_alert')
        ->and($captured[0][1]['p95_ms'])->toBe(20000);
});
