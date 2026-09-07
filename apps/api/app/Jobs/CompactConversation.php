<?php

namespace App\Jobs;

use App\Domain\Ai\AiBroadcast;
use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\TokenEstimator;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

/**
 * FR-AI-005 — roll the oldest half of the recent window into the
 * conversation summary so long chats keep fitting the context budget.
 * Unique per conversation; messages stay fully readable in the UI.
 */
class CompactConversation implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 2;

    public function __construct(public readonly string $conversationId) {}

    public function uniqueId(): string
    {
        return $this->conversationId;
    }

    public function handle(ContextBuilder $builder, TokenEstimator $estimator): void
    {
        $conversation = AiConversation::query()->findOrFail($this->conversationId);

        $recent = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('seq', '>', $conversation->summary_up_to_seq)
            ->whereIn('status', ['completed', 'cancelled'])
            ->whereNull('superseded_at')
            ->orderBy('seq')
            ->get();

        if ($recent->count() < 2) {
            return;
        }

        $providerRow = AiProvider::defaultProvider();
        if ($providerRow === null) {
            return;
        }

        $half = $recent->take((int) ceil($recent->count() / 2));
        $transcript = $half->map(fn (AiMessage $m) => "{$m->role}: {$m->content}")->implode("\n");

        try {
            $summary = OpenAiCompatibleProvider::make($providerRow)->chat([
                ['role' => 'system', 'content' => 'สรุปบทสนทนาให้เก็บข้อเท็จจริง การตัดสินใจ สิ่งที่ค้าง และบริบทที่จำเป็นต่อการคุยต่อ ตอบเป็นข้อ ๆ กระชับ'],
                ['role' => 'user', 'content' => ($conversation->summary !== null ? "สรุปเดิม:\n{$conversation->summary}\n\n" : '')."บทสนทนา:\n{$transcript}"],
            ], $providerRow->memory_model);
        } catch (AiProviderException) {
            return; // next completed turn re-triggers
        }

        if (trim($summary) === '') {
            return;
        }

        $budget = $builder->budgetIn($providerRow);
        $maxTokens = (int) floor($budget * 0.2);
        if ($estimator->estimate($summary) > $maxTokens) {
            $summary = mb_substr($summary, 0, (int) ($maxTokens * 3.5)); // rough char clip
        }

        $upTo = (int) $half->max('seq');

        $conversation->forceFill([
            'summary' => trim($summary),
            'summary_up_to_seq' => $upTo,
            'summary_tokens' => $estimator->estimate($summary),
        ])->save();

        AiBroadcast::toUser($conversation->user_id, 'ai.conversation.compacted', [
            'conversation_id' => $conversation->id,
            'summary_up_to_seq' => $upTo,
        ]);
    }
}
