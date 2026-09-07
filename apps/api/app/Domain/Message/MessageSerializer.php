<?php

namespace App\Domain\Message;

use App\Domain\Media\AttachmentSerializer;
use App\Models\Message;

/**
 * Single message shape for API responses and EVT-010/011 payloads (§8.8).
 * Deleted messages keep seq but drop content (FR-MSG-003 deleted placeholder).
 */
class MessageSerializer
{
    public function __construct(
        private readonly AttachmentSerializer $attachments,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function toArray(Message $message): array
    {
        $deleted = $message->deleted_at !== null;

        $replyTo = null;
        if ($message->relationLoaded('replyTo') && $message->replyTo !== null) {
            $original = $message->replyTo;
            $replyTo = [
                'id' => $original->id,
                'sender_id' => $original->sender_id,
                'snippet' => $original->deleted_at !== null ? null : ($original->body !== null
                    ? mb_substr($original->body, 0, 100)
                    : '[ไฟล์แนบ]'),
                'deleted' => $original->deleted_at !== null,
            ];
        }

        $sender = $message->relationLoaded('sender') && $message->sender !== null ? [
            'id' => $message->sender->id,
            'username' => $message->sender->username,
            'display_name' => $message->sender->display_name,
            'avatar_attachment_id' => $message->sender->avatar_attachment_id,
        ] : null;

        return [
            'id' => $message->id,
            'room_id' => $message->room_id,
            'workspace_id' => $message->workspace_id,
            'sender_id' => $message->sender_id,
            'sender' => $sender,
            'type' => $message->type->value,
            'body' => $deleted ? null : $message->body,
            'seq' => (int) $message->seq,
            'client_message_id' => $message->client_message_id,
            'reply_to' => $replyTo,
            'system_event' => $deleted ? null : $message->system_event,
            'edited_at' => $message->edited_at?->toIso8601String(),
            'edit_count' => (int) $message->edit_count,
            'deleted_at' => $message->deleted_at?->toIso8601String(),
            'delete_reason' => $message->delete_reason,
            'created_at' => $message->created_at?->toIso8601String(),
            'mentions' => $deleted ? [] : ($message->relationLoaded('mentions')
                ? $message->mentions->pluck('id')->values()->all()
                : []),
            'attachments' => $deleted ? [] : $this->serializeAttachments($message),
        ];
    }

    /**
     * Serialize a message with sender/replyTo/attachments loaded, no lazy queries.
     *
     * @return array<string, mixed>
     */
    public static function forEvent(Message $message): array
    {
        $message->loadMissing(
            ['sender' => fn ($q) => $q->select(['id', 'username', 'display_name', 'avatar_attachment_id'])],
            'attachments',
            'mentions:id',
        );

        return app(self::class)->toArray($message);
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function serializeAttachments(Message $message): array
    {
        if (! $message->relationLoaded('attachments')) {
            return [];
        }

        return $message->attachments
            ->sortBy(fn ($a) => $a->pivot->position ?? 0)
            ->values()
            ->map(fn ($a) => $this->attachments->toArray($a))
            ->all();
    }
}
