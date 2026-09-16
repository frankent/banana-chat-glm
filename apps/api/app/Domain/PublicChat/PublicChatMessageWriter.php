<?php

namespace App\Domain\PublicChat;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Exceptions\ApiException;
use App\Models\Attachment;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRead;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;

/**
 * FR-PCHAT-002/009/011/015 — the correctness-critical write path for the public
 * chat bounded context.
 *
 * ==== THIS IS A SECOND WRITE PIPELINE, AND THAT IS THE ACCEPTED COST ========
 * DEC-064 / trade-off #1 / R7: this re-implements MessageWriter's
 * lockForUpdate -> idempotency lookup -> seq = last_seq + 1 -> attachment claim
 * discipline. A bug fixed in MessageWriter is NOT automatically fixed here. The
 * mitigation is deliberate structural similarity — keep the method bodies
 * shaped like MessageWriter's so a diff review is cheap — plus the gapless-seq
 * assertion in TC-PCHAT-010. Do not "refactor" the two into a shared base: the
 * whole point of the isolation angle is that MessageWriter::write(User $sender)
 * never becomes nullable.
 *
 * ==== AUTO-CLAIM IS A DATABASE GUARANTEE, NOT A CHECK ======================
 * The claim runs INSIDE the same lockForUpdate transaction that assigns seq. Two
 * agents replying concurrently therefore serialise on the room row: the first
 * sees assigned_to IS NULL and claims, the second sees the claim already made.
 * "Exactly one claim, exactly one `claimed` system row" is enforced by the lock,
 * not by a read-then-write race (TC-PCHAT-010/011).
 *
 * ==== WORKSPACE ISOLATION ==================================================
 * Every query here filters workspace_id explicitly IN ADDITION to room_id, and
 * uses withoutGlobalScopes() where the caller may be Tier 2 (no context at all,
 * where WorkspaceScope silently no-ops). Neither the scope nor the explicit
 * filter is sufficient alone — DEC-070.
 */
class PublicChatMessageWriter
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly PublicChatGate $gate,
        private readonly PublicChatPublicSerializer $public,
        private readonly PublicChatStaffSerializer $staff,
    ) {}

    /**
     * Writes ONE content row (visitor or agent) plus, for an agent's first reply
     * to an unclaimed room, the `claimed` system row — both under one lock.
     *
     * `$clientMessageId` is REQUIRED, never nullable (DEC-066 / graft 26): the
     * column is NOT NULL and part of the idempotency unique, and a client that
     * may omit it gets no idempotency at all while the index that justified the
     * design does nothing. `sender_kind` is the middle column of that unique, so
     * a visitor — who supplies a free-form value — cannot squat an agent's id
     * and have the agent's send return the visitor's row as a 200 replay
     * (graft 13 / TC-PCHAT-041).
     *
     * @param  list<string>  $attachmentIds
     * @return array{0: PublicChatMessage, 1: bool} [message, created]
     */
    public function write(
        PublicChatRoom $room,
        PublicChatSenderKind $kind,
        ?User $sender,
        ?string $body,
        string $clientMessageId,
        ?string $replyToMessageId = null,
        array $attachmentIds = [],
    ): array {
        if ($kind === PublicChatSenderKind::System) {
            // System rows are appended under a caller-held lock, never here.
            throw new \InvalidArgumentException('Use appendSystem() for system rows.');
        }

        if ($kind === PublicChatSenderKind::Agent && $sender === null) {
            throw new \InvalidArgumentException('An agent row requires its User.');
        }

        $body = $body !== null ? trim($body) : null;
        $body = $body === '' ? null : $body; // whitespace-only counts as empty

        $maxLength = $this->gate->maxMessageLength();
        if ($body !== null && mb_strlen($body) > $maxLength) {
            throw ApiException::msgTooLong($maxLength);
        }

        if ($body === null && $attachmentIds === []) {
            throw ApiException::msgEmpty();
        }

        if (count($attachmentIds) > $this->settings->int('message.max_attachments')) {
            throw ApiException::msgAttachmentInvalid();
        }

        // DUPLICATE IDS ARE A 422, NOT A 500. public_chat_message_attachments is
        // PRIMARY (message_id, attachment_id), so [$id, $id] made it all the way
        // into the pivot insert and surfaced as a QueryException — a 500 on an
        // UNAUTHENTICATED route, handing a prober a stack-shaped error and a
        // half-written transaction for one trivially craftable body. Rejected
        // here, before the room lock: there is no reason to serialise on the room
        // row to refuse a body we can already see is malformed. array_values()
        // re-indexes so the list<string> contract downstream still holds.
        if (count(array_unique($attachmentIds)) !== count($attachmentIds)) {
            throw ApiException::msgAttachmentInvalid();
        }

        $attachmentIds = array_values($attachmentIds);

        if ($replyToMessageId !== null) {
            $replyExists = PublicChatMessage::withoutGlobalScopes()
                ->where('room_id', $room->id)
                ->where('workspace_id', $room->workspace_id)
                ->whereKey($replyToMessageId)
                ->exists();

            if (! $replyExists) {
                throw ApiException::msgReplyInvalid();
            }
        }

        /** @var array{0: PublicChatMessage, 1: bool, 2: ?PublicChatMessage, 3: bool} $result */
        $result = DB::transaction(function () use ($room, $kind, $sender, $body, $clientMessageId, $replyToMessageId, $attachmentIds): array {
            /** @var PublicChatRoom $locked */
            $locked = PublicChatRoom::withoutGlobalScopes()
                ->whereKey($room->id)
                ->where('workspace_id', $room->workspace_id)
                ->lockForUpdate()
                ->firstOrFail();

            // Idempotent replay — ALL THREE columns of the unique, or a visitor
            // could match an agent's row (graft 13).
            $existing = PublicChatMessage::withoutGlobalScopes()
                ->where('room_id', $locked->id)
                ->where('workspace_id', $locked->workspace_id)
                ->where('sender_kind', $kind->value)
                ->where('client_message_id', $clientMessageId)
                ->first();

            if ($existing !== null) {
                return [$existing, false, null, false];
            }

            $seq = (int) $locked->last_seq + 1;

            // Claimed under the room lock so two concurrent sends can never
            // reuse the same attachment.
            $attachments = $this->claimAttachments($locked, $attachmentIds);

            $message = PublicChatMessage::withoutGlobalScopes()->create([
                'room_id' => $locked->id,
                'workspace_id' => $locked->workspace_id,
                'seq' => $seq,
                'sender_kind' => $kind,
                'sender_user_id' => $kind === PublicChatSenderKind::Agent ? $sender?->id : null,
                // WRITE-TIME SNAPSHOTS. The public serializer builds
                // "Provider (username)" from these and never joins `users`, so a
                // later rename cannot retroactively rewrite the customer's
                // transcript and a buggy join cannot leak a user row externally.
                'agent_username_snapshot' => $kind === PublicChatSenderKind::Agent ? $sender?->username : null,
                'provider_name_snapshot' => $kind === PublicChatSenderKind::Agent ? $locked->provider_name : null,
                'type' => $this->deriveType($attachments),
                'body' => $body,
                'reply_to_message_id' => $replyToMessageId,
                'client_message_id' => $clientMessageId,
            ]);

            foreach ($attachments as $position => $attachment) {
                $message->attachments()->attach($attachment->id, ['position' => $position + 1]);
            }

            $updates = [
                'last_seq' => $seq,
                'last_message_at' => now(),
            ];

            $systemRow = null;
            $roomChanged = false;

            if ($kind === PublicChatSenderKind::Visitor) {
                $updates['last_visitor_seq'] = $seq;
            } else {
                $updates['last_agent_seq'] = $seq;

                // MANDATORY graft 21 — one timestamp, stamped by the same
                // UPDATE, yields first-response-time: the number any support
                // operation is judged on.
                if ($locked->first_response_at === null) {
                    $updates['first_response_at'] = now();
                }

                // ---- AUTO-CLAIM (FR-PCHAT-009) ---------------------------
                if ($locked->assigned_to === null) {
                    $updates['assigned_to'] = $sender->id;
                    $updates['claimed_at'] = now();

                    // `problem` is a triage flag an agent set deliberately;
                    // replying must not silently clear it. Only `new` advances.
                    if ($locked->status === PublicChatStatus::New) {
                        $updates['status'] = PublicChatStatus::InProgress->value;
                    }

                    $locked->forceFill($updates)->save();

                    $systemRow = $this->appendSystem($locked, PublicChatSystemEvent::Claimed, [
                        'actor_username' => $sender->username,
                        'to' => $locked->status->value,
                    ]);

                    $roomChanged = true;
                    $updates = [];
                }
            }

            if ($updates !== []) {
                $locked->forceFill($updates)->save();
            }

            // FR-PCHAT-010 — an agent has trivially read their own message.
            if ($kind === PublicChatSenderKind::Agent) {
                PublicChatRead::markRead($locked->id, $sender->id, $locked->workspace_id, (int) $locked->last_seq);
            }

            $room->setRawAttributes($locked->getAttributes(), true);

            return [$message, true, $systemRow, $roomChanged];
        });

        [$message, $created, $systemRow, $roomChanged] = $result;

        if ($created) {
            $this->broadcastMessage($room, $message);

            if ($systemRow !== null) {
                $this->broadcastMessage($room, $systemRow);
            }

            if ($roomChanged) {
                $this->broadcastRoomChanged($room);
            }

            // MANDATORY grafts 3/20 — agents must actually be told. Never
            // Jobs/NotifyMessage: its first act is a silent early-return on a
            // null sender, which every visitor row has.
            if ($kind === PublicChatSenderKind::Visitor) {
                NotifyPublicChatMessage::dispatch($message->id)->afterCommit();
            }
        }

        return [$message, $created];
    }

    /**
     * Appends one system row. THE CALLER MUST ALREADY HOLD THE ROOM LOCK inside
     * a transaction — this reads and bumps $locked->last_seq, and doing that
     * outside the lock reintroduces the seq race the lock exists to remove.
     *
     * MANDATORY graft 11: system rows have no client, but client_message_id is
     * NOT NULL and part of the idempotency unique, so the server generates a
     * ULID. Without it the FIRST status change violates the constraint.
     *
     * body is NULL on purpose (FR-I18N-001): each serializer renders the
     * sentence in the READER's locale from system_event + system_meta. Baking a
     * Thai string into body would be unreadable to an 'en' visitor.
     *
     * @param  array<string, mixed>  $meta
     */
    public function appendSystem(PublicChatRoom $locked, PublicChatSystemEvent $event, array $meta = []): PublicChatMessage
    {
        $seq = (int) $locked->last_seq + 1;

        $message = PublicChatMessage::withoutGlobalScopes()->create([
            'room_id' => $locked->id,
            'workspace_id' => $locked->workspace_id,
            'seq' => $seq,
            'sender_kind' => PublicChatSenderKind::System,
            'sender_user_id' => null,
            'type' => PublicChatMessageType::System,
            'body' => null,
            'system_event' => $event,
            'system_meta' => $meta === [] ? null : $meta,
            'client_message_id' => PublicChatMessage::newSystemClientId(),
        ]);

        $locked->forceFill(['last_seq' => $seq])->save();

        return $message;
    }

    /**
     * DEC-065 — two classes, two serializers, two channels. The internal payload
     * is built and broadcast SEPARATELY from the public one so internal identity
     * cannot cross the visitor channel even if a serializer is edited wrongly:
     * the boundary is the wire, not a field list.
     */
    public function broadcastMessage(PublicChatRoom $room, PublicChatMessage $message): void
    {
        $message->loadMissing(['attachments', 'replyTo', 'senderUser']);

        // DEC-074 — the visitor channel is the OTHER half of the zero-delta
        // suppression. Filtering only API-211 would have closed the transcript
        // while leaving the realtime frame wide open: private-public-chat.{rid}
        // delivers within milliseconds of the agent's click, which is a SHARPER
        // timing signal than the polled list, not a lesser one. The predicate
        // lives on the serializer so the two surfaces cannot disagree.
        //
        // The STAFF frame is always sent. An agent must see the transition.
        if ($this->public->visibleToVisitor($message)) {
            broadcast(new PublicChatMessageCreated($room, $this->public->message($message, $room)));
        }

        broadcast(new PublicChatMessageCreatedStaff($room, $this->staff->message($message, $room)));
    }

    /**
     * EVT-081 both variants. can_send here is the ROOM-level answer — feature on,
     * link live, conversation open. The per-viewer term (a signed-in member is
     * never allowed to send as the visitor, FR-PCHAT-013) is not knowable on a
     * broadcast and is applied by API-210 for each caller.
     *
     * DEC-074 — $visitorVisible is the SIBLING of the message-channel
     * suppression, and leaving it out would have made that suppression
     * cosmetic. The visitor payload is {id, status_public, can_send}: on an
     * in_progress -> problem transition every one of those three fields is
     * BYTE-FOR-BYTE IDENTICAL to the last frame, so the event carries no
     * information except the fact that something changed, right now — which is
     * precisely the timing signal the status projection exists to hide. A
     * caller that knows the visitor-visible projection did not move passes
     * false; everyone else keeps the default, because suppressing a frame that
     * DOES carry a change would strand the visitor's page on stale state.
     *
     * The staff frame is unconditional: an agent's queue must move the moment
     * the flag is set.
     */
    public function broadcastRoomChanged(PublicChatRoom $room, bool $visitorVisible = true): void
    {
        $canSend = $this->gate->enabled() && ! $room->isExpired() && ! $room->isClosed();

        if ($visitorVisible) {
            broadcast(new PublicChatRoomChanged($room, $canSend));
        }

        broadcast(new PublicChatRoomChangedStaff($room, $this->staff->room($room->load('assignedTo'))));
    }

    /**
     * FR-PCHAT-020 / DEC-068 / R6 — THE PARTITION, ENFORCED FROM THIS SIDE.
     *
     * An attachment carrying public_chat_room_id can be claimed ONLY by a message
     * in THAT room, and the ownership test is ROOM-SCOPED, not uploader-scoped:
     * a visitor upload has uploader_id NULL by design, so "is this yours?" has no
     * meaning here. The mirror-image guard lives in MessageWriter::claimAttachments
     * (`->whereNull('public_chat_room_id')`), and the internal claim paths are
     * additionally fail-closed by construction because NULL never equals a ULID
     * in their `uploader_id === $actor->id` tests.
     *
     * The four pivot checks stop an attachment already spent on an internal
     * message, a note or a ticket from being re-used here (TC-PCHAT-021/022).
     *
     * @param  list<string>  $attachmentIds
     * @return list<Attachment>
     */
    private function claimAttachments(PublicChatRoom $room, array $attachmentIds): array
    {
        if ($attachmentIds === []) {
            return [];
        }

        $attachments = Attachment::withoutGlobalScopes()
            ->whereKey($attachmentIds)
            ->lockForUpdate()
            ->get()
            ->mapWithKeys(fn (Attachment $a) => [$a->id => $a]);

        foreach ($attachmentIds as $id) {
            $attachment = $attachments->get($id);

            $ok = $attachment !== null
                && $attachment->workspace_id === $room->workspace_id
                && $attachment->public_chat_room_id === $room->id
                && $attachment->deleted_at === null
                && $attachment->kind !== AttachmentKind::Avatar
                && in_array($attachment->status, [AttachmentStatus::Ready, AttachmentStatus::Processing, AttachmentStatus::Uploaded], true)
                && ! DB::table('public_chat_message_attachments')->where('attachment_id', $attachment->id)->exists()
                && ! DB::table('message_attachments')->where('attachment_id', $attachment->id)->exists()
                && ! DB::table('room_note_attachments')->where('attachment_id', $attachment->id)->exists()
                && ! DB::table('kanban_ticket_attachments')->where('attachment_id', $attachment->id)->exists();

            if (! $ok) {
                // One uniform 422 — never leak whether the id exists, belongs to
                // another room, or is simply spent.
                throw ApiException::msgAttachmentInvalid();
            }
        }

        return array_map(fn (string $id) => $attachments->get($id), $attachmentIds);
    }

    /**
     * All image -> image, all video -> video, else/mixed -> file, none -> text.
     * Structurally identical to MessageWriter::deriveType, minus the call/meet
     * types that do not exist in this context.
     *
     * @param  list<Attachment>  $attachments
     */
    private function deriveType(array $attachments): PublicChatMessageType
    {
        if ($attachments === []) {
            return PublicChatMessageType::Text;
        }

        $kinds = array_map(fn (Attachment $a) => $a->kind, $attachments);

        $allImages = ! in_array(false, array_map(fn ($k) => $k === AttachmentKind::Image, $kinds), true);
        $allVideos = ! in_array(false, array_map(fn ($k) => $k === AttachmentKind::Video, $kinds), true);

        if ($allImages) {
            return PublicChatMessageType::Image;
        }

        if ($allVideos) {
            return PublicChatMessageType::Video;
        }

        return PublicChatMessageType::File;
    }
}
