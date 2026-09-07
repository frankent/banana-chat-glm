<?php

use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\MemoryExtractionParser;
use App\Domain\Ai\SseParser;
use App\Domain\Ai\TokenEstimator;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUserMemory;
use App\Models\User;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

// FR-AI-005/006/019 — pure domain units (TC-AI-037..050, TC-AI-051..053,
// TC-AI-104..108 subset)

test('TC-AI-104 TokenEstimator: thai dense, latin sparse, ratio scales', function () {
    $estimator = new TokenEstimator;

    $thai = $estimator->estimate(str_repeat('ท', 120));
    $latin = $estimator->estimate(str_repeat('a', 120));

    expect($thai)->toBeGreaterThan($latin)          // 120/1.2 vs 120/3.5 chars-per-token
        ->and($thai)->toBeGreaterThan(0)
        ->and($estimator->estimate(''))->toBe(0);

    $scaled = $estimator->estimate(str_repeat('a', 120), 2.0);
    expect($scaled)->toBeGreaterThan($latin);
});

test('TC-AI-105 TokenEstimator EMA ratio converges toward observed', function () {
    $estimator = new TokenEstimator;

    $first = $estimator->nextRatio(null, estimated: 100, actualPromptTokens: 200);
    expect($first)->toBe(2.0);

    $next = $estimator->nextRatio($first, estimated: 100, actualPromptTokens: 100);
    expect($next)->toBeGreaterThan(1.0)->toBeLessThan(2.0);
});

test('TC-AI-106 SseParser survives CRLF, split chunks and [DONE]', function () {
    $parser = new SseParser;

    $events = $parser->push("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\r\n");
    expect($events)->toHaveCount(1);

    // a payload cut mid-line across two chunks
    $events = $parser->push('data: {"choices":[{"delta":{"cont');
    expect($events)->toHaveCount(0);

    $events = $parser->push("ent\":\"llo\"}}]}\n\ndata: [DONE]\n\n");
    expect($events)->toHaveCount(1)
        ->and($events[0]['choices'][0]['delta']['content'])->toBe('llo')
        ->and($parser->isDone())->toBeTrue();
});

test('TC-AI-107 SseParser skips comments and blank boundaries', function () {
    $parser = new SseParser;

    $events = $parser->push(": keep-alive\n\ndata: {\"x\":1}\n\n");

    expect($events)->toHaveCount(1)->and($events[0])->toBe(['x' => 1]);
});

test('TC-AI-108 SseParser tolerates usage-only final chunk', function () {
    $parser = new SseParser;

    $events = $parser->push("data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\ndata: [DONE]\n");

    expect($events[0]['usage']['prompt_tokens'])->toBe(7)
        ->and($parser->isDone())->toBeTrue();
});

test('TC-AI-051 MemoryExtractionParser: clean json, fences, garbage', function () {
    $parser = new MemoryExtractionParser;

    $clean = $parser->parse('{"add":[{"content":"ชื่อเล่น โทนี่","category":"profile","importance":4}],"update":[],"delete":[]}');
    expect($clean['add'])->toHaveCount(1)
        ->and($clean['add'][0]['category'])->toBe('profile')
        ->and($clean['add'][0]['importance'])->toBe(4);

    $fenced = $parser->parse("Here you go:\n```json\n{\"add\":[],\"update\":[{\"id\":\"01H\",\"content\":\"x\"}],\"delete\":[\"02H\"]}\n```");
    expect($fenced['update'])->toHaveCount(1)
        ->and($fenced['delete'])->toBe(['02H']);

    $garbage = $parser->parse('I cannot do JSON today');
    expect($garbage)->toBe(['add' => [], 'update' => [], 'delete' => []]);
});

test('TC-AI-053 parser clamps importance and category, clips long content', function () {
    $parser = new MemoryExtractionParser;

    $diff = $parser->parse(json_encode([
        'add' => [['content' => str_repeat('ย', 400), 'category' => 'secret', 'importance' => 99]],
    ]));

    expect($diff['add'][0]['importance'])->toBe(5)
        ->and($diff['add'][0]['category'])->toBe('other')
        ->and(mb_strlen($diff['add'][0]['content']))->toBe(300);
});

test('TC-AI-037 ContextBuilder budget math keeps headroom', function () {
    $provider = makeAiProviderRow(['window_size' => 100000, 'max_output_tokens' => 4096]);
    $builder = app(ContextBuilder::class);

    expect($builder->budgetIn($provider))->toBe(100000 - 4096 - 2000);
});

test('TC-AI-038 ContextBuilder drops oldest turns but keeps the newest', function () {
    $user = User::factory()->create();
    $provider = makeAiProviderRow(['window_size' => 20000, 'max_output_tokens' => 4096]); // budget ≈ 15.6k tokens
    $conversation = AiConversation::create(['user_id' => $user->id, 'last_message_at' => now()]);

    // ~2.2k tokens per message → 12 messages ≈ 26k tokens > budget
    $big = str_repeat('word ', 1500);
    foreach (range(1, 12) as $i) {
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $user->id, 'seq' => $i * 2 - 1,
            'role' => 'user', 'content' => $big.' q'.$i, 'status' => 'completed',
        ]);
        AiMessage::create([
            'conversation_id' => $conversation->id, 'user_id' => $user->id, 'seq' => $i * 2,
            'role' => 'assistant', 'content' => $big.' a'.$i, 'status' => 'completed',
        ]);
    }

    $messages = app(ContextBuilder::class)->build($conversation, $provider, collect());
    $bodies = array_column($messages, 'content');

    expect(count($messages))->toBeLessThan(25) // system + a strict subset of the 24 turns
        ->and($messages[0]['role'])->toBe('system')
        ->and(end($bodies))->toContain('a12') // newest assistant turn kept
        ->and(in_array($big.' q1', $bodies, true))->toBeFalse(); // oldest dropped
});

test('TC-AI-039 ContextBuilder injects summary + memories into the system block', function () {
    $user = User::factory()->create();
    $provider = makeAiProviderRow();
    $conversation = AiConversation::create([
        'user_id' => $user->id,
        'summary' => 'ผู้ใช้กำลังวางแผน deploy วันศุกร์',
        'summary_up_to_seq' => 4,
        'last_message_at' => now(),
    ]);
    AiMessage::create([
        'conversation_id' => $conversation->id, 'user_id' => $user->id, 'seq' => 5,
        'role' => 'user', 'content' => 'ต่อจากเมื่อวาน', 'status' => 'completed',
    ]);

    $memory = AiUserMemory::create([
        'user_id' => $user->id, 'content' => 'ชื่อเล่น โทนี่', 'category' => 'profile', 'importance' => 5,
    ]);

    $messages = app(ContextBuilder::class)->build($conversation, $provider, collect([$memory]));

    expect($messages[0]['content'])->toContain('สิ่งที่รู้เกี่ยวกับผู้ใช้')
        ->and($messages[0]['content'])->toContain('[profile] ชื่อเล่น โทนี่')
        ->and($messages[0]['content'])->toContain('สรุปบทสนทนาก่อนหน้า')
        ->and($messages[1]['content'])->toBe('ต่อจากเมื่อวาน')
        ->and($memory->refresh()->last_used_at)->not->toBeNull();
});

test('TC-AI-040 memory disable → ContextBuilder skips inject', function () {
    $user = User::factory()->create();
    $provider = makeAiProviderRow();
    $conversation = AiConversation::create(['user_id' => $user->id, 'last_message_at' => now()]);

    // memories with deleted_at are pre-filtered by the caller (active scope)
    $messages = app(ContextBuilder::class)->build($conversation, $provider, collect());

    expect($messages[0]['content'])->not->toContain('สิ่งที่รู้เกี่ยวกับผู้ใช้');
});

test('TC-AI-044 messageTooLong rejects a single message over half the budget', function () {
    $user = User::factory()->create();
    $provider = makeAiProviderRow(['window_size' => 20000, 'max_output_tokens' => 4096]); // budget ≈ 15.6k
    $conversation = AiConversation::create(['user_id' => $user->id, 'last_message_at' => now()]);

    $builder = app(ContextBuilder::class);

    expect($builder->messageTooLong(str_repeat('a', 40000), $conversation, $provider))->toBeTrue()
        ->and($builder->messageTooLong('short one', $conversation, $provider))->toBeFalse();
});

// ---- helpers -----------------------------------------------------------

function makeAiProviderRow(array $override = []): AiProvider
{
    return AiProvider::create(array_merge([
        'name' => 'test-'.Str::ulid(),
        'provider_type' => 'openai_compatible',
        'base_url' => 'https://ai.test/v1',
        'api_key_encrypted' => Crypt::encryptString('sk-test'),
        'api_key_last4' => 'test',
        'model' => 'glm-5.2',
        'model_source' => 'custom',
        'window_size' => 200000,
        'max_output_tokens' => 4096,
        'temperature' => 0.7,
        'system_prompt' => 'คุณคือผู้ช่วยขององค์กร ตอบภาษาไทย',
        'is_enabled' => true,
        'is_default' => false,
        'created_by' => null,
    ], $override));
}
