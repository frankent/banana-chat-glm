<?php

namespace App\Domain\PublicChat;

use App\Domain\Media\AttachmentSerializer;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Models\Attachment;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;

/**
 * FR-PCHAT-014 · DEC-065 — THE CUSTOMER-FACING PAYLOAD.
 *
 * DELIBERATELY HAS NO SHARED BASE CLASS WITH PublicChatStaffSerializer. A shared
 * base is precisely how a field added for staff leaks to the customer; two
 * places to add a field is the point, not an oversight. Every method here
 * WHITELISTS — nothing is delegated to a serializer someone else may extend.
 *
 * WHAT MUST NEVER APPEAR IN ANYTHING THIS CLASS RETURNS:
 *   - any user ULID, username or display_name of a member (agents appear only
 *     as "Provider (username)" assembled from WRITE-TIME SNAPSHOTS, so `users`
 *     is never joined and a later rename never rewrites the transcript)
 *   - room.meta, the partner's arbitrary payload
 *   - room.assigned_to / claimed_at / first_response_at / external_ref
 *   - the RAW status. `problem` is an internal triage flag and a customer
 *     discovering support flagged their conversation is a real disclosure
 *     (MANDATORY graft 1). Everything visitor-facing carries `status_public`.
 *     That includes system_meta: a `status_changed` row whose raw
 *     {from:'in_progress',to:'problem'} was passed through would leak the exact
 *     value the projection exists to hide (TC-PCHAT-032).
 *
 * All strings here are rendered as PLAIN TEXT nodes by every client.
 * customer_name / provider_name are attacker-controlled from the partner's own
 * site: never Markdown, never dangerouslySetInnerHTML, never {!! !!}.
 */
class PublicChatPublicSerializer
{
    public function __construct(
        private readonly AttachmentSerializer $attachments,
    ) {}

    /**
     * API-210 room block. `id` IS included and must be: the visitor page cannot
     * derive the room ULID from its code, and it needs the ULID to subscribe to
     * private-public-chat.{id} — which is exactly why the channel is keyed by
     * the ULID and never by the 64-hex code (MANDATORY fix 12).
     *
     * @return array<string, mixed>
     */
    public function room(PublicChatRoom $room): array
    {
        return [
            'id' => $room->id,
            'customer_name' => $room->customer_name,
            'provider_name' => $room->provider_name,
            'status_public' => $room->statusPublic(),
            'locale' => $room->locale,
            'created_at' => $room->created_at?->toIso8601String(),
            'expires_at' => $room->expires_at?->toIso8601String(),
            'last_seq' => (int) $room->last_seq,
        ];
    }

    /**
     * EVT-081 visitor variant — {status_public, can_send} ONLY. The visitor
     * never learns who is assigned, or that anyone is.
     *
     * @return array<string, mixed>
     */
    public function roomChanged(PublicChatRoom $room, bool $canSend): array
    {
        return [
            'id' => $room->id,
            'status_public' => $room->statusPublic(),
            'can_send' => $canSend,
        ];
    }

    /**
     * DEC-074 — A ZERO-DELTA STATUS ROW IS A TIMING SIDE-CHANNEL.
     *
     * `problem` is an internal triage flag and projectStatus() exists to keep it
     * off the customer surface: in_progress and problem BOTH project to 'open'.
     * But PublicChatService::patch appends a `status_changed` system row for
     * EVERY real transition, and this serializer rendered it. So the moment an
     * agent flagged a conversation as a problem, the visitor's transcript grew a
     * system row reading, in effect, "status changed from open to open" — timed
     * exactly to the flag. The field-level projection was perfect and the
     * EXISTENCE of the row leaked the thing anyway.
     *
     * Suppressed on the VISITOR side only. The staff serializer is untouched:
     * the transition is real, an agent must see who changed what and when, and
     * an audit trail with holes in it is worse than no audit trail.
     *
     * OMITTED, not replaced with a placeholder. The visitor client
     * (PublicChatVisitorPage) advances its `after_seq` cursor from the highest
     * seq it has RECEIVED and simply appends whatever API-211 returns — it never
     * compares against room.last_seq — so a permanent gap in the visitor's seq
     * sequence costs nothing and cannot drive a refetch loop. A placeholder row
     * would have re-leaked the timing the suppression exists to hide.
     */
    public function visibleToVisitor(PublicChatMessage $message): bool
    {
        if ($message->system_event !== PublicChatSystemEvent::StatusChanged) {
            return true;
        }

        $meta = $message->system_meta ?? [];
        $from = $this->projectStatus($meta['from'] ?? null);
        $to = $this->projectStatus($meta['to'] ?? null);

        // Evaluated BEFORE the isDeleted() branch in message(), so a staff-
        // deleted zero-delta row does not resurface to the visitor as a
        // tombstone — which would leak the same timing in a different shape.
        return $from === null || $to === null || $from !== $to;
    }

    /**
     * @param  iterable<PublicChatMessage>  $messages
     * @return list<array<string, mixed>>
     */
    public function messages(iterable $messages, PublicChatRoom $room): array
    {
        $out = [];

        foreach ($messages as $message) {
            if (! $this->visibleToVisitor($message)) {
                continue;
            }

            $out[] = $this->message($message, $room);
        }

        return $out;
    }

    /**
     * $room is passed explicitly so a visitor row can be labelled with
     * customer_name without a per-row lazy load — and so this class never has a
     * reason to touch a relation that could reach `users`.
     *
     * @return array<string, mixed>
     */
    public function message(PublicChatMessage $message, PublicChatRoom $room): array
    {
        // PublicChatMessage has NO SoftDeletes trait — deleted_at is a plain
        // column, so soft-deleted rows STAY in query results and the tombstone
        // is rendered here. Doing it any other way would silently renumber the
        // transcript's seq gaps for the customer.
        if ($message->isDeleted()) {
            return [
                'id' => $message->id,
                'seq' => (int) $message->seq,
                'sender_kind' => $message->sender_kind->value,
                'display_name' => null,
                'type' => $message->type->value,
                'body' => null,
                'system_event' => null,
                'system_meta' => null,
                'reply_to' => null,
                'attachments' => [],
                'deleted' => true,
                'created_at' => $message->created_at?->toIso8601String(),
            ];
        }

        return [
            'id' => $message->id,
            'seq' => (int) $message->seq,
            'sender_kind' => $message->sender_kind->value,
            'display_name' => $this->displayName($message, $room),
            'type' => $message->type->value,
            'body' => $message->body,
            'system_event' => $message->system_event?->value,
            'system_meta' => $this->systemMeta($message),
            'reply_to' => $this->replyTo($message),
            'attachments' => $this->attachmentList($message),
            'deleted' => false,
            'created_at' => $message->created_at?->toIso8601String(),
        ];
    }

    /**
     * Agent rows: "Provider (username)" from snapshots — NEVER a join on
     * `users`. Visitor rows: the customer's own name, so the transcript reads
     * the same on both devices a forwarded link is opened on. System rows: no
     * author at all; the client renders the sentence from system_event +
     * system_meta in the READER's locale (FR-I18N-001), which is why system
     * bodies are NULL in the database.
     */
    private function displayName(PublicChatMessage $message, PublicChatRoom $room): ?string
    {
        return match ($message->sender_kind) {
            PublicChatSenderKind::Agent => $message->externalDisplayName(),
            PublicChatSenderKind::Visitor => $room->customer_name,
            PublicChatSenderKind::System => null,
        };
    }

    /**
     * WHITELIST, and for `status_changed` a PROJECTION. Anything not named here
     * is dropped: system_meta also carries actor_username on staff rows, which
     * is internal identity and must not cross this boundary.
     *
     * @return array<string, mixed>|null
     */
    private function systemMeta(PublicChatMessage $message): ?array
    {
        if ($message->system_event === null) {
            return null;
        }

        $meta = $message->system_meta ?? [];

        // claimed / reassigned tell the visitor nothing they may know — an
        // agent's identity and the fact of assignment are both internal.
        if ($message->system_event !== PublicChatSystemEvent::StatusChanged) {
            return [];
        }

        return array_filter([
            'from' => $this->projectStatus($meta['from'] ?? null),
            'to' => $this->projectStatus($meta['to'] ?? null),
        ], fn ($v) => $v !== null);
    }

    /** The single projection: new|in_progress|problem => open, done => closed. */
    private function projectStatus(mixed $raw): ?string
    {
        if (! is_string($raw)) {
            return null;
        }

        return PublicChatStatus::tryFrom($raw)?->public();
    }

    /**
     * MANDATORY graft 4 — reply/quote. SNIPPET ONLY: no sender id, no sender
     * kind, no display name. Quoting which of three questions an agent is
     * answering needs the text, not the author.
     *
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
            'snippet' => $parent->deleted_at !== null ? null : mb_substr((string) $parent->body, 0, 120),
        ];
    }

    /**
     * FIELD WHITELIST rather than delegation to AttachmentSerializer::toArray(),
     * so a field added there in future cannot reach the customer. The signed
     * URLs themselves are safe without a bearer — they are 60-minute temporary
     * GETs — but the shape of the envelope is ours to control.
     *
     * @return list<array<string, mixed>>
     */
    private function attachmentList(PublicChatMessage $message): array
    {
        $rows = $message->relationLoaded('attachments')
            ? $message->getRelation('attachments')
            : $message->attachments()->get();

        $out = [];

        foreach ($rows as $attachment) {
            /** @var Attachment $attachment */
            $full = $this->attachments->toArray($attachment);

            $out[] = [
                'id' => $full['id'],
                'kind' => $full['kind'],
                'status' => $full['status'],
                'original_name' => $full['original_name'],
                'mime_type' => $full['mime_type'],
                'size_bytes' => $full['size_bytes'],
                'width' => $full['width'],
                'height' => $full['height'],
                'duration_ms' => $full['duration_ms'],
                'urls' => $full['urls'],
                'urls_expire_at' => $full['urls_expire_at'],
            ];
        }

        return $out;
    }
}
