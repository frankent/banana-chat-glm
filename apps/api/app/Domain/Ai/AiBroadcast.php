<?php

namespace App\Domain\Ai;

use App\Events\AiEvent;
use App\Models\AiConversation;
use App\Models\AiMessage;

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
    public static function message(AiMessage $message, ?string $partial = null, ?int $lastIndex = null): array
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
            'created_at' => $message->created_at?->toIso8601String(),
            'completed_at' => $message->completed_at?->toIso8601String(),
        ];

        if ($partial !== null) {
            $payload['partial_content'] = $partial;
            $payload['last_index'] = $lastIndex;
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

    public static function toUser(string $userId, string $event, array $data): void
    {
        broadcast(new AiEvent($userId, $event, $data));
    }
}
