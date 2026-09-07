<?php

namespace App\Jobs;

use App\Domain\Ai\AiBroadcast;
use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\TokenEstimator;
use App\Domain\Notification\FcmPushSender;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUsageDaily;
use App\Models\AiUserMemory;
use App\Models\Device;
use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * FR-AI-003 — stream the assistant reply for a pending ai_message.
 * Runs on the `ai` queue (timeout 660s): status transitions → SSE deltas
 * buffered in Redis and flushed as ai.message.delta events → completion
 * bookkeeping (tokens, usage, memory/compaction/title follow-ups, push).
 */
class GenerateAiReply implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $timeout = 660;

    public int $tries = 2;

    public function __construct(public readonly string $messageId) {}

    public function handle(
        ContextBuilder $builder,
        TokenEstimator $estimator,
        SettingsService $settings,
    ): void {
        $message = AiMessage::query()->find($this->messageId);
        if ($message === null || in_array($message->status, ['completed', 'cancelled'], true)) {
            return; // purged or already finalized (cancel raced us)
        }

        $conversation = AiConversation::query()->findOrFail($message->conversation_id);
        $providerRow = AiProvider::defaultProvider();
        if ($providerRow === null) {
            $this->fail($message, 'AI_PROVIDER_NOT_CONFIGURED');

            return;
        }

        try {
            $client = OpenAiCompatibleProvider::make($providerRow);
            $this->generate($message, $conversation, $providerRow, $client, $builder, $estimator, $settings);
        } catch (AiProviderException $e) {
            if ($e->errorCode === 'AI_CONTEXT_OVERFLOW') {
                // FR-AI-005: synchronous compaction, one retry, then give up
                CompactConversation::dispatchSync($conversation->id);
                $conversation->refresh();

                try {
                    $client = OpenAiCompatibleProvider::make($providerRow);
                    $this->generate($message, $conversation, $providerRow, $client, $builder, $estimator, $settings);

                    return;
                } catch (AiProviderException $retry) {
                    $e = $retry;
                }
            }

            $this->fail($message, $e->errorCode, $e->providerDetail ?? $e->getMessage());
        } catch (Throwable $e) {
            report($e);
            $this->fail($message, 'AI_PROVIDER_ERROR', $e->getMessage());
        }
    }

    private function generate(
        AiMessage $message,
        AiConversation $conversation,
        AiProvider $providerRow,
        OpenAiCompatibleProvider $client,
        ContextBuilder $builder,
        TokenEstimator $estimator,
        SettingsService $settings,
    ): void {
        $userId = $message->user_id;

        // FR-AI-006: memories inject into the system block
        $memories = AiUserMemory::query()
            ->active()
            ->where('user_id', $userId)
            ->orderByDesc('importance')
            ->orderByDesc('last_used_at')
            ->get();

        $messages = $builder->build($conversation, $providerRow, $memories);
        $promptEstimate = array_sum(array_map(
            fn (array $m) => $estimator->estimate($m['content'], $conversation->token_ratio) + 4,
            $messages,
        ));

        $message->forceFill(['status' => 'streaming', 'started_at' => now(), 'model' => $providerRow->model])->save();
        AiBroadcast::toUser($userId, 'ai.message.started', [
            'conversation_id' => $conversation->id, 'message_id' => $message->id,
        ]);

        $bufferKey = "ai:gen:{$message->id}";
        $cancelKey = "ai:cancel:{$message->id}";

        $content = '';
        $pending = '';
        $index = -1;
        $lastFlush = microtime(true);
        $flushMs = $settings->int('ai.stream.flush_interval_ms');
        $firstTokenAt = null;
        $usage = null;
        $finishReason = null;
        $cancelled = false;

        foreach ($client->chatStream($messages) as $chunk) {
            if (Redis::exists($cancelKey) === 1) { // FR-AI-004
                $cancelled = true;

                break;
            }

            if ($chunk['type'] === 'delta') {
                $firstTokenAt ??= microtime(true);
                $pending .= $chunk['text'];
                $content .= $chunk['text'];
            } elseif ($chunk['type'] === 'usage') {
                $usage = $chunk['usage'];
            } elseif ($chunk['type'] === 'done') {
                $finishReason = $chunk['finish_reason'];
            }

            $sinceFlush = (microtime(true) - $lastFlush) * 1000;
            if ($pending !== '' && ($sinceFlush >= $flushMs || mb_strlen($pending) >= 40)) {
                $index++;
                Redis::rPush($bufferKey, $pending);
                Redis::expire($bufferKey, 3600);
                AiBroadcast::toUser($userId, 'ai.message.delta', [
                    'conversation_id' => $conversation->id,
                    'message_id' => $message->id,
                    'index' => $index,
                    'delta' => $pending,
                ]);
                $pending = '';
                $lastFlush = microtime(true);
            }
        }

        // trailing tail that never hit the flush threshold
        if ($pending !== '') {
            $index++;
            Redis::rPush($bufferKey, $pending);
            Redis::expire($bufferKey, 3600);
            AiBroadcast::toUser($userId, 'ai.message.delta', [
                'conversation_id' => $conversation->id,
                'message_id' => $message->id,
                'index' => $index,
                'delta' => $pending,
            ]);
        }

        $totalMs = (int) ((microtime(true) - ($firstTokenAt ?? microtime(true))) * 1000);
        $firstMs = $firstTokenAt !== null && defined('\\LARAVEL_START')
            ? (int) (($firstTokenAt - \LARAVEL_START) * 1000)
            : null;

        $tokensIn = $usage['prompt_tokens'] ?? $estimator->estimate(implode("\n", array_column($messages, 'content')), $conversation->token_ratio);
        $tokensOut = $usage['completion_tokens'] ?? $estimator->estimate($content);

        $message->forceFill([
            'content' => $content,
            'status' => $cancelled ? 'cancelled' : 'completed',
            'finish_reason' => $cancelled ? 'cancelled' : ($finishReason ?? 'stop'),
            'tokens_prompt' => $tokensIn,
            'tokens_completion' => $tokensOut,
            'tokens_source' => $usage !== null ? 'provider' : 'estimated',
            'latency_first_token_ms' => $firstMs,
            'latency_total_ms' => $totalMs,
            'completed_at' => now(),
        ])->save();

        // conversation bookkeeping + ratio EMA (DEC-018)
        $conversation->forceFill([
            'last_message_at' => now(),
            'total_tokens_in' => $conversation->total_tokens_in + $tokensIn,
            'total_tokens_out' => $conversation->total_tokens_out + $tokensOut,
            'token_ratio' => $estimator->nextRatio($conversation->token_ratio, $promptEstimate, $tokensIn),
        ])->save();

        Redis::del($cancelKey);
        AiBroadcast::toUser($userId, 'ai.message.completed', [
            'message' => AiBroadcast::message($message->refresh()),
        ]);
        AiUsageDaily::bump($userId, $message->workspace_id, messages: 0, tokensIn: $tokensIn, tokensOut: $tokensOut);

        // follow-ups
        ExtractMemories::dispatch($conversation->id, $message->id)->delay(now()->addSeconds(60));

        $budget = $builder->budgetIn($providerRow);
        $recentTokens = (int) AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('seq', '>', $conversation->summary_up_to_seq)
            ->whereIn('status', ['completed', 'cancelled'])
            ->whereNull('superseded_at')
            ->selectRaw('COALESCE(SUM(LENGTH(COALESCE(content, \'\'))), 0) AS chars')
            ->value('chars');
        if ($estimator->estimate(str_repeat('x', (int) min($recentTokens, 100000)), $conversation->token_ratio) > $budget * $settings->float('ai.compaction.trigger_ratio')) {
            CompactConversation::dispatch($conversation->id);
        }

        if ($conversation->title === null && $conversation->title_source === null && $conversation->message_count <= 2) {
            GenerateTitle::dispatch($conversation->id);
        }

        $this->maybePush($userId, $conversation->id);
    }

    /**
     * FR-AI-003 step 6 — ai_completed push unless a device focused the
     * conversation within the suppression window (API-118 sets the key).
     */
    private function maybePush(string $userId, string $conversationId): void
    {
        $key = "ai:focus:{$conversationId}:{$userId}";
        if (Redis::exists($key) === 1) {
            return;
        }

        try {
            $device = Device::query()
                ->where('user_id', $userId)
                ->whereNotNull('push_token')
                ->whereNull('push_disabled_at')
                ->first();

            if ($device !== null) {
                app(FcmPushSender::class)->send($device, [
                    'title' => 'AI Assistant',
                    'body' => 'AI ตอบกลับเรียบร้อยแล้ว',
                    'data' => ['conversation_id' => $conversationId],
                    'collapse_key' => "ai.{$conversationId}",
                    'badge' => 0,
                ]);
            }
        } catch (Throwable) {
            // push failure must never fail the completed generation
        }
    }

    private function fail(AiMessage $message, string $errorCode, ?string $detail = null): void
    {
        $message->forceFill([
            'status' => 'failed',
            'error_code' => $errorCode,
            'error_detail' => $detail !== null ? mb_substr($detail, 0, 500) : null,
            'completed_at' => now(),
        ])->save();

        AiUsageDaily::bump($message->user_id, $message->workspace_id, failed: 1);
        AiBroadcast::toUser($message->user_id, 'ai.message.failed', [
            'conversation_id' => $message->conversation_id,
            'message_id' => $message->id,
            'error_code' => $errorCode,
        ]);
    }
}
