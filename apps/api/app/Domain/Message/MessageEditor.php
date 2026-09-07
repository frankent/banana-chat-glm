<?php

namespace App\Domain\Message;

use App\Enums\MessageType;
use App\Enums\RoomRole;
use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Exceptions\ApiException;
use App\Jobs\PurgeAttachmentFiles;
use App\Models\Message;
use App\Models\MessageEdit;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;

/**
 * FR-MSG-005/006 — edit (sender-only, inside window) and soft delete
 * (sender anytime, room owner/admin or workspace admin as moderator).
 * Edits are silent (no push, no unread). Deletes keep seq, null the body,
 * detach attachments (files purged after 24h) and recompute last_message.
 */
class MessageEditor
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly MessageSerializer $serializer,
        private readonly AuditLogger $audit,
    ) {}

    public function edit(Message $message, User $actor, ?string $body): Message
    {
        $body = trim((string) $body);
        $this->assertEditableBy($message, $actor);

        $maxLength = $this->settings->int('message.max_length');
        if (mb_strlen($body) > $maxLength) {
            throw ApiException::msgTooLong($maxLength);
        }

        if ($body === '' && ! $message->attachments()->exists()) {
            throw ApiException::msgEmpty();
        }

        return DB::transaction(function () use ($message, $actor, $body): Message {
            MessageEdit::query()->create([
                'message_id' => $message->id,
                'previous_body' => $message->body ?? '',
                'edited_by' => $actor->id,
                'edited_at' => now(),
            ]);

            $message->forceFill([
                'body' => $body === '' ? null : $body,
                'edited_at' => now(),
                'edit_count' => $message->edit_count + 1,
            ])->save();

            $fresh = $message->refresh();
            $fresh->loadMissing('sender:id,username,display_name,avatar_attachment_id', 'attachments');

            broadcast(new MessageUpdated($fresh->room()->firstOrFail(), MessageSerializer::forEvent($fresh)));

            return $fresh;
        });
    }

    /**
     * @param  'sender'|'moderator'  $forcedBy  moderator path (admin delete)
     */
    public function delete(Message $message, User $actor, string $forcedBy = 'sender'): Message
    {
        // idempotent replay (FR-MSG-006 AC)
        if ($message->deleted_at !== null) {
            return $message;
        }

        $room = $message->room()->firstOrFail();

        DB::transaction(function () use ($message, $actor, $forcedBy, $room): void {
            $attachments = $message->attachments()->pluck('attachments.id')->all();

            $message->forceFill([
                'body' => null,
                'deleted_at' => now(),
                'delete_reason' => $forcedBy,
            ])->save();

            if ($attachments !== []) {
                $message->attachments()->detach();
                // FR-MSG-006: files go away after the 24h admin-recovery window
                PurgeAttachmentFiles::dispatch($attachments)->delay(now()->addDay());
            }

            // deleted message was the room's last_message → fall back to the
            // newest non-deleted one (room list preview recomputes from it)
            if ($room->last_message_id === $message->id) {
                $previous = Message::query()
                    ->where('room_id', $room->id)
                    ->whereNull('deleted_at')
                    ->orderByDesc('seq')
                    ->first();

                $room->forceFill([
                    'last_message_id' => $previous?->id,
                    'last_message_at' => $previous?->created_at ?? $room->created_at,
                ])->save();
            }

            if ($forcedBy === 'moderator') {
                $this->audit->log('message.deleted_moderator', $actor, 'message', $message->id, [
                    'room_id' => $room->id,
                    'seq' => $message->seq,
                ], $room->workspace_id);
            }
        });

        broadcast(new MessageDeleted($room, $message->id, (int) $message->seq, $forcedBy));

        return $message;
    }

    /**
     * Who may delete: sender (no time limit) or owner/admin of the room, or
     * workspace admin (moderator path per FR-MSG-006).
     */
    public function assertDeletableBy(Message $message, User $actor, ?RoomMember $membership): string
    {
        if ($message->sender_id === $actor->id) {
            return 'sender';
        }

        $isModerator = $membership !== null
            && in_array($membership->role, [RoomRole::Owner, RoomRole::Admin], true);

        if (! $isModerator) {
            throw ApiException::roomForbidden();
        }

        return 'moderator';
    }

    private function assertEditableBy(Message $message, User $actor): void
    {
        if ($message->type === MessageType::System || $message->deleted_at !== null) {
            throw ApiException::msgNotEditable();
        }

        if ($message->sender_id !== $actor->id) {
            throw ApiException::roomForbidden(); // spec AC: คนอื่นแก้ → 403
        }

        $window = $this->settings->int('message.edit_window_minutes');
        if ($window > 0 && $message->created_at !== null && $message->created_at->diffInMinutes(now()) > $window) {
            throw ApiException::msgEditWindowExpired();
        }
    }
}
