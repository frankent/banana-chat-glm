<?php

namespace App\Domain\Ai;

use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use App\Models\AiUserMemory;
use App\Services\SettingsService;
use Illuminate\Support\Collection;

/**
 * FR-AI-005/006 — assembles the provider message list:
 * system prompt + injected user memories + rolling summary + recent
 * turns, kept under budget_in = window − max_output − 2% headroom.
 * Pure of network so it is unit-testable.
 */
class ContextBuilder
{
    public function __construct(
        private readonly TokenEstimator $estimator,
        private readonly SettingsService $settings,
    ) {}

    /**
     * @param  Collection<int, AiUserMemory>  $memories  pre-selected active memories
     * @return list<array{role: string, content: string}>
     */
    public function build(AiConversation $conversation, AiProvider $provider, Collection $memories): array
    {
        $ratio = $conversation->token_ratio;
        $budget = $this->budgetIn($provider);

        $system = trim((string) ($provider->system_prompt ?? ''))."\n\n".$this->memoryBlock($memories, $ratio);

        if ($conversation->summary !== null && $conversation->summary !== '') {
            $summaryBlock = "## สรุปบทสนทนาก่อนหน้า\n".$conversation->summary;
            $maxSummaryTokens = (int) floor($budget * 0.2);
            if ($this->estimator->estimate($summaryBlock, $ratio) > $maxSummaryTokens) {
                // clip the tail — compaction should have kept it small already
                $summaryBlock = mb_substr($summaryBlock, 0, (int) ($maxSummaryTokens * 3.5 / self::MARGIN_SAFE));
            }
            $system .= "\n\n".$summaryBlock;
        }

        $systemTokens = $this->estimator->estimate($system, $ratio);

        // newest → oldest, stop once the accumulated size would overflow
        /** @var list<AiMessage> $recent */
        $recent = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('seq', '>', (int) ($conversation->summary_up_to_seq ?? 0))
            ->whereNull('superseded_at')
            ->whereIn('status', ['completed', 'cancelled'])
            ->orderByDesc('seq')
            ->get()
            ->all();

        $used = $systemTokens;
        $chosen = [];
        foreach ($recent as $message) {
            $cost = $this->estimator->estimate((string) ($message->content ?? ''), $ratio) + 4; // + role/chatter
            if ($used + $cost > $budget && $chosen !== []) {
                break; // never drop the newest turn — it was pre-validated to fit
            }
            $used += $cost;
            $chosen[] = $message;
        }

        $messages = [['role' => 'system', 'content' => $system]];
        foreach (array_reverse($chosen) as $message) {
            $messages[] = [
                'role' => $message->role, // user|assistant
                'content' => (string) ($message->content ?? ''),
            ];
        }

        return $messages;
    }

    public function budgetIn(AiProvider $provider): int
    {
        return max(
            1024,
            $provider->window_size - $provider->max_output_tokens - (int) ceil($provider->window_size * 0.02),
        );
    }

    /**
     * FR-AI-003 — single latest user message larger than 50% of budget is
     * rejected before any rows are written (422 AI_MESSAGE_TOO_LONG).
     */
    public function messageTooLong(string $content, AiConversation $conversation, AiProvider $provider): bool
    {
        return $this->estimator->estimate($content, $conversation->token_ratio) > $this->budgetIn($provider) * 0.5;
    }

    /**
     * FR-AI-006 — top-N memories within inject_max_tokens; marks them used.
     *
     * @param  Collection<int, AiUserMemory>  $memories
     */
    private function memoryBlock(Collection $memories, ?float $ratio): string
    {
        $max = $this->settings->int('ai.memory.inject_max');
        $maxTokens = $this->settings->int('ai.memory.inject_max_tokens');

        $lines = [];
        $used = 0;
        foreach ($memories->take($max) as $memory) {
            $line = "- [{$memory->category}] {$memory->content}";
            $cost = $this->estimator->estimate($line, $ratio);
            if ($used + $cost > $maxTokens) {
                break;
            }
            $used += $cost;
            $lines[] = $line;
            $memory->forceFill(['last_used_at' => now()])->save();
        }

        if ($lines === []) {
            return '';
        }

        return "## สิ่งที่รู้เกี่ยวกับผู้ใช้ (อาจล้าสมัย ให้ผู้ใช้แก้ไขได้)\n".implode("\n", $lines);
    }

    private const MARGIN_SAFE = 1.1; // mirrors TokenEstimator margin for char-budget clipping
}
