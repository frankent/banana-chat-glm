<?php

namespace App\Domain\Ai;

use App\Events\AiEvent;
use App\Models\AiConversation;
use App\Models\AiMessage;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Serialization + fan-out helpers shared by the AI jobs and controller.
 */
class AiBroadcast
{
    /**
     * §8.9 ai_message shape.
     *
     * @return array<string, mixed>
     */
    public static function message(AiMessage $message, ?string $partial = null, ?int $lastIndex = null, array $steps = []): array
    {
        $payload = [
            'id' => $message->id,
            'conversation_id' => $message->conversation_id,
            'seq' => (int) $message->seq,
            'role' => $message->role,
            'status' => $message->status,
            'content' => $message->status === 'completed' ? (string) $message->content : null,
            'client_message_id' => $message->client_message_id,
            'parent_message_id' => $message->parent_message_id,
            'model' => $message->model,
            'finish_reason' => $message->finish_reason,
            'tokens_prompt' => $message->tokens_prompt,
            'tokens_completion' => $message->tokens_completion,
            'error_code' => $message->error_code,
            'superseded_at' => $message->superseded_at?->toIso8601String(), // DEC-042 (FR-AI-009 "1/2" toggle)
            'created_at' => $message->created_at?->toIso8601String(),
            'completed_at' => $message->completed_at?->toIso8601String(),
        ];

        if ($partial !== null) {
            $payload['partial_content'] = $partial;
            $payload['last_index'] = $lastIndex;
        }

        if ($steps !== []) {
            $payload['steps'] = $steps;
        }

        return $payload;
    }

    /**
     * §8.9 ai_conversation_summary shape.
     */
    public static function conversationSummary(AiConversation $conversation): array
    {
        return [
            'id' => $conversation->id,
            'title' => $conversation->title,
            'title_source' => $conversation->title_source,
            'message_count' => (int) $conversation->message_count,
            'last_message_at' => $conversation->last_message_at?->toIso8601String(),
            'archived_at' => $conversation->archived_at?->toIso8601String(),
            'generating' => AiMessage::query()
                ->where('conversation_id', $conversation->id)
                ->whereIn('status', ['pending', 'streaming'])
                ->exists(),
        ];
    }

    /**
     * AiEvent is ShouldBroadcastNow, so this publishes to Reverb on the calling
     * thread — which for deltas is the middle of GenerateAiReply's stream loop.
     * A transport hiccup there used to be its own tiny queue job; now it would
     * escape into the job's catch (Throwable) and fail the whole answer as
     * AI_PROVIDER_ERROR. The answer is persisted either way and the client
     * refetches, so a lost frame is worth far less than a lost reply.
     */
    public static function toUser(string $userId, string $event, array $data): void
    {
        try {
            broadcast(new AiEvent($userId, $event, $data));
        } catch (Throwable $e) {
            Log::warning('ai.broadcast.failed', [
                'event' => $event,
                'user_id' => $userId,
                'conversation_id' => $data['conversation_id'] ?? null,
                'message_id' => $data['message_id'] ?? null,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
