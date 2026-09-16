<?php

namespace App\Domain\PublicChat;

use App\Domain\Media\AttachmentSerializer;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\User;

/**
 * DEC-065 — THE INTERNAL PAYLOAD, for Tier 3 and for
 * private-public-chat-staff.{roomId}.
 *
 * NO SHARED BASE CLASS WITH PublicChatPublicSerializer, deliberately: the two
 * payloads differ in exactly the fields that matter, and a common parent is how
 * a staff-only field silently acquires a customer-facing route. If you add a
 * field here and the customer needs it too, add it to the other class BY HAND.
 *
 * Anything this class returns may be shown to an active workspace member and to
 * nobody else. It carries user ULIDs, usernames, room.meta and the RAW status
 * including `problem` — all four of which the public serializer exists to keep
 * off the wire.
 *
 * VISITOR-SUPPLIED AND PARTNER-SUPPLIED STRINGS (customer_name, provider_name,
 * external_ref, meta, body) are rendered as PLAIN TEXT on the agent surface
 * too: markdown applies to message BODY only, names never.
 */
class PublicChatStaffSerializer
{
    public function __construct(
        private readonly AttachmentSerializer $attachments,
    ) {}

    /**
     * StaffRoom — API-220 rows and API-221.
     *
     * $myLastReadSeq / $unreadCount come from public_chat_reads
     * (FR-PCHAT-010, MANDATORY graft 15): the per-agent pointer that lets an
     * agent see "I have 3 unread here" rather than only the room-level
     * needs_reply signal. THE POINTER NEVER AFFECTS QUEUE ORDER — the sort is
     * one formula for every viewer (pinned decision 5).
     *
     * The 64-hex `code` is NOT serialised. It is the visitor's bearer
     * credential; an agent has no use for it (API-203 rotate-link is the
     * partner's endpoint) and every surface it reaches is another place it can
     * leak.
     *
     * @return array<string, mixed>
     */
    public function room(PublicChatRoom $room, int $myLastReadSeq = 0, ?int $unreadCount = null): array
    {
        $lastSeq = (int) $room->last_seq;

        return [
            'id' => $room->id,
            'customer_name' => $room->customer_name,
            'provider_name' => $room->provider_name,
            'external_ref' => $room->external_ref,
            'status' => $room->status->value,
            'status_public' => $room->statusPublic(),
            'locale' => $room->locale,
            'assigned_to' => $this->user($room->relationLoaded('assignedTo') ? $room->getRelation('assignedTo') : $room->assignedTo),
            'claimed_at' => $room->claimed_at?->toIso8601String(),
            'first_response_at' => $room->first_response_at?->toIso8601String(),
            'needs_reply' => $room->needsReply(),
            'last_seq' => $lastSeq,
            'last_visitor_seq' => (int) $room->last_visitor_seq,
            'last_agent_seq' => (int) $room->last_agent_seq,
            'my_last_read_seq' => $myLastReadSeq,
            'unread_count' => $unreadCount ?? max(0, $lastSeq - $myLastReadSeq),
            'last_message_at' => $room->last_message_at?->toIso8601String(),
            'created_at' => $room->created_at?->toIso8601String(),
            'expires_at' => $room->expires_at?->toIso8601String(),
            'closed_at' => $room->closed_at?->toIso8601String(),
            // The partner's "...etc data with payload". Agent-only, and rendered
            // as <pre>{{ json }}</pre> — never as HTML.
            'meta' => $room->meta,
        ];
    }

    /**
     * @param  iterable<PublicChatMessage>  $messages
     * @return list<array<string, mixed>>
     */
    public function messages(iterable $messages, PublicChatRoom $room): array
    {
        $out = [];

        foreach ($messages as $message) {
            $out[] = $this->message($message, $room);
        }

        return $out;
    }

    /**
     * @return array<string, mixed>
     */
    public function message(PublicChatMessage $message, PublicChatRoom $room): array
    {
        $deleted = $message->isDeleted();

        return [
            'id' => $message->id,
            'room_id' => $message->room_id,
            'seq' => (int) $message->seq,
            'sender_kind' => $message->sender_kind->value,
            'sender' => $this->user($message->relationLoaded('senderUser') ? $message->getRelation('senderUser') : $message->senderUser),
            // The same string the customer sees, so an agent can tell at a
            // glance how their message was signed externally.
            'external_display_name' => $message->externalDisplayName(),
            'visitor_display_name' => $room->customer_name,
            'type' => $message->type->value,
            'body' => $deleted ? null : $message->body,
            'system_event' => $message->system_event?->value,
            // RAW system_meta: staff get {from,to,actor_username} unprojected.
            'system_meta' => $message->system_meta,
            'reply_to' => $this->replyTo($message),
            'attachments' => $deleted ? [] : $this->attachmentList($message),
            'client_message_id' => $message->client_message_id,
            'deleted' => $deleted,
            'deleted_at' => $message->deleted_at?->toIso8601String(),
            'deleted_by' => $message->deleted_by,
            'created_at' => $message->created_at?->toIso8601String(),
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    public function user(?User $user): ?array
    {
        return $user === null ? null : [
            'id' => $user->id,
            'username' => $user->username,
            'display_name' => $user->display_name,
        ];
    }

    /**
     * @return array<string, mixed>|null
     */
    private function replyTo(PublicChatMessage $message): ?array
    {
        $parent = $message->relationLoaded('replyTo')
            ? $message->getRelation('replyTo')
            : $message->replyTo()->first();

        if ($parent === null) {
            return null;
        }

        return [
            'id' => $parent->id,
            'seq' => (int) $parent->seq,
            'sender_kind' => $parent->sender_kind->value,
            'snippet' => $parent->deleted_at !== null ? null : mb_substr((string) $parent->body, 0, 120),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function attachmentList(PublicChatMessage $message): array
    {
        $rows = $message->relationLoaded('attachments')
            ? $message->getRelation('attachments')
            : $message->attachments()->get();

        return collect($rows)->map(fn ($a) => $this->attachments->toArray($a))->values()->all();
    }
}
