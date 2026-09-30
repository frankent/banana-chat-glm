<?php

namespace App\Jobs;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Models\Attachment;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

/**
 * FR-PROF-006 — reclaim replaced/removed AVATARS. users.avatar_attachment_id
 * is the ONLY reference to an avatar row: the moment PATCH /me points
 * elsewhere (or clears it), the previous photo is an orphan nothing will ever
 * look at again. Mirrors PurgeExpiredUploads::purgeUnreferencedPublicChat —
 * same conditional-delete race guard, same "row goes first" ordering — but
 * keyed on the users table instead of the public-chat pivot.
 */
class PurgeOrphanAttachments implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    /**
     * Why a CONSTANT, matching PurgeExpiredUploads::PUBLIC_CHAT_ORPHAN_GRACE_HOURS:
     * this is a storage-hygiene floor, not an operator knob. 24h is far past
     * the 1h ceiling of any avatar URL a client may still be displaying
     * (AvatarUrls::expiresAt), and past the replace→regret window of a user
     * flipping between photos, while still bounding an account's orphaned
     * avatar bytes to one day.
     */
    public const AVATAR_ORPHAN_GRACE_HOURS = 24;

    public function handle(): void
    {
        $cutoff = now()->subHours(self::AVATAR_ORPHAN_GRACE_HOURS);
        $purged = 0;
        $bytes = 0;

        Attachment::withoutGlobalScopes()
            ->where('kind', AttachmentKind::Avatar->value)
            ->whereIn('status', self::reclaimableStatuses())
            ->where('created_at', '<', $cutoff)
            ->tap(fn ($q) => self::whereUnreferenced($q))
            ->chunkById(500, function ($orphans) use (&$purged, &$bytes): void {
                /** @var FilesystemAdapter $disk */
                $disk = Storage::disk(config('filesystems.default'));

                foreach ($orphans as $attachment) {
                    // The SELECT and this DELETE are not one atomic act: the
                    // user can re-point users.avatar_attachment_id back at
                    // this row in between (PATCH /me). Re-asserting every NOT
                    // EXISTS inside the DELETE closes that race as a database
                    // guarantee — 0 rows affected means skip the objects too.
                    // Same shape and rationale as the public-chat sweep.
                    $deleted = Attachment::withoutGlobalScopes()
                        ->whereKey($attachment->id)
                        ->tap(fn ($q) => self::whereUnreferenced($q))
                        ->delete();

                    if ($deleted === 0) {
                        continue; // re-claimed while we were looking away
                    }

                    // A ready avatar has thumb_sm/thumb_md that cost as much
                    // as the original; reclaim both or neither.
                    $keys = array_values(array_filter(array_merge(
                        [$attachment->storage_key],
                        array_values($attachment->derived ?? []),
                    )));

                    foreach ($keys as $key) {
                        try {
                            $disk->delete($key);
                        } catch (\Throwable $e) {
                            Log::warning('media.purge_failed', [
                                'attachment_id' => $attachment->id,
                                'key' => $key,
                                'error' => $e->getMessage(),
                            ]);
                        }
                    }

                    $bytes += (int) $attachment->size_bytes;
                    $purged++;
                }
            });

        if ($purged > 0) {
            Log::info('media.avatar_orphans_purged', [
                'count' => $purged,
                'bytes' => $bytes,
                'grace_hours' => self::AVATAR_ORPHAN_GRACE_HOURS,
            ]);
        }
    }

    /**
     * Pending belongs to PurgeExpiredUploads (it has a real expires_at);
     * deleted is a tombstone whose bytes PurgeAttachmentFiles reclaimed.
     *
     * @return list<string>
     */
    private static function reclaimableStatuses(): array
    {
        return [
            AttachmentStatus::Uploaded->value,
            AttachmentStatus::Processing->value,
            AttachmentStatus::Ready->value,
            AttachmentStatus::Failed->value,
        ];
    }

    /**
     * "Referenced by nothing", ONE definition for the SELECT and the DELETE
     * (if the two drifted, the gap would be exactly the race the conditional
     * delete exists to close). users.avatar_attachment_id is the reference
     * that matters; the four pivots are asserted because being wrong means
     * deleting a file out from under a live message.
     *
     * @param  Builder<Attachment>  $query
     */
    private static function whereUnreferenced($query): void
    {
        // rooms/workspaces accept any attachment id as their avatar, so a
        // kind=avatar row can be a room or workspace photo too.
        foreach (['users', 'rooms', 'workspaces'] as $owner) {
            $query->whereNotExists(
                fn ($sub) => $sub->select(DB::raw(1))
                    ->from($owner)
                    ->whereColumn($owner.'.avatar_attachment_id', 'attachments.id')
            );
        }

        foreach ([
            'public_chat_message_attachments',
            'message_attachments',
            'room_note_attachments',
            'kanban_ticket_attachments',
        ] as $pivot) {
            $query->whereNotExists(
                fn ($sub) => $sub->select(DB::raw(1))
                    ->from($pivot)
                    ->whereColumn($pivot.'.attachment_id', 'attachments.id')
            );
        }
    }
}
