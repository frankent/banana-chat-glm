<?php

namespace App\Jobs;

use App\Domain\Ai\AiBroadcast;
use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Models\AiConversation;
use App\Models\AiMessage;
use App\Models\AiProvider;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

/**
 * FR-AI-008 — after the first turn, auto-title the conversation (≤ 6 words,
 * user's language, no quotes). A user-set title (title_source=user) is
 * never overwritten.
 */
class GenerateTitle implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 2;

    public function __construct(public readonly string $conversationId) {}

    public function handle(): void
    {
        $conversation = AiConversation::query()->findOrFail($this->conversationId);

        if ($conversation->title !== null || $conversation->title_source === 'user') {
            return;
        }

        $providerRow = AiProvider::defaultProvider();
        if ($providerRow === null) {
            return;
        }

        $firstUserMessage = AiMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('role', 'user')
            ->orderBy('seq')
            ->value('content');

        if ($firstUserMessage === null) {
            return;
        }

        try {
            $title = OpenAiCompatibleProvider::make($providerRow)->chat([
                ['role' => 'system', 'content' => 'ตั้งชื่อบทสนทนาสั้นที่สุดไม่เกิน 6 คำ ใช้ภาษาเดียวกับข้อความผู้ใช้ ห้ามใส่เครื่องหมายคำพูด ตอบชื่อเฉพาะอย่างเดียว'],
                ['role' => 'user', 'content' => mb_substr((string) $firstUserMessage, 0, 500)],
            ], $providerRow->memory_model);
        } catch (AiProviderException) {
            return;
        }

        $title = trim($title, " \t\n\r\0\x0B\"'“”");
        if ($title === '') {
            return;
        }

        $conversation->forceFill([
            'title' => mb_substr($title, 0, 100),
            'title_source' => 'auto',
        ])->save();

        AiBroadcast::toUser($conversation->user_id, 'ai.conversation.updated', [
            'conversation_summary' => AiBroadcast::conversationSummary($conversation->refresh()),
        ]);
    }
}
