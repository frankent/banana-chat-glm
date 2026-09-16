<?php

namespace App\Domain\Media;

use App\Models\Attachment;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Carbon;

/**
 * FR-ROOM-012 — secret-room expiry for the media pipeline.
 *
 * S3/Spaces presigned GETs cannot be revoked once issued, so the server caps
 * every URL it hands out for an attachment bound to a secret room at the
 * room's deadline: a URL issued after binding never outlives the room.
 *
 * Bounded limitation (DEC-056): URLs issued while the attachment is still
 * UNBOUND (composer polling `GET /attachments/{id}` before the message send
 * claims it) keep their regular ≤60 min TTL — a presigned URL already in a
 * client's hands cannot be shortened retroactively. Exposure is bounded by
 * that TTL; no fresh URL is issued after expiry (410 ROOM_EXPIRED / 404 on
 * the signed file route).
 */
class SecretAttachmentExpiry
{
    /**
     * True when the attachment is referenced by a message or note inside a
     * secret room past its expiry (row not yet swept).
     */
    public static function boundToExpiredRoom(Attachment $attachment): bool
    {
        return self::secretRoomQuery($attachment)
            ->where('secret_expires_at', '<=', now())
            ->exists();
    }

    /** Exact expiry, including sub-minute deadlines; never round past room expiry. */
    public static function expiresAt(Attachment $attachment, int $defaultMinutes = AttachmentSerializer::URL_TTL_MINUTES): Carbon
    {
        $maximum = now()->addMinutes($defaultMinutes);
        $deadline = self::secretRoomQuery($attachment)->min('secret_expires_at');

        return $deadline === null ? $maximum : $maximum->min(Carbon::parse($deadline));
    }

    /**
     * Secret rooms (any liveness — the cap must apply even mid-sweep) that
     * reference this attachment through a message or a note.
     */
    private static function secretRoomQuery(Attachment $attachment): \Illuminate\Database\Query\Builder
    {
        return DB::table('rooms')
            ->where('is_secret', true)
            ->where(fn ($q) => $q
                ->whereIn('id', fn ($sub) => $sub->select('messages.room_id')
                    ->from('messages')
                    ->join('message_attachments', 'message_attachments.message_id', '=', 'messages.id')
                    ->where('message_attachments.attachment_id', $attachment->id))
                ->orWhereIn('id', fn ($sub) => $sub->select('room_notes.room_id')
                    ->from('room_notes')
                    ->join('room_note_attachments', 'room_note_attachments.room_note_id', '=', 'room_notes.id')
                    ->where('room_note_attachments.attachment_id', $attachment->id)));
    }
}
