<?php

namespace App\Jobs;

use App\Domain\Media\S3Multipart;
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
 * FR-MEDIA-001 AC — pending uploads that never completed (1h expiry)
 * get their object/multipart session and row removed. TC-MEDIA-011.
 *
 * FR-PCHAT-020 / DEC-073 — plus the COMPLETED-but-unreferenced public chat
 * sweep below, which is a different failure mode with a different query.
 */
class PurgeExpiredUploads implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    /**
     * DEC-073 — how long a FINISHED public-chat attachment may sit unreferenced
     * before it is reclaimed.
     *
     * A CONSTANT, not an §4.4 setting, and deliberately so: SettingsService's
     * own header warns that a NUMERIC key added to DEFAULTS without a matching
     * App\Filament\Pages\Settings::ranges() entry throws for every admin who
     * opens the settings page — and Settings.php is out of this change's scope.
     * A constant is also the honest shape: this is a storage-hygiene floor, not
     * a knob an operator has any reason to tune.
     *
     * WHY 24 HOURS. The gap being closed is seconds wide in the happy path —
     * a visitor picks a file, the PUT completes, the send follows immediately —
     * so anything past that is slack for the unhappy ones:
     *   - ProcessAttachment sitting in a backed-up queue (status Uploaded or
     *     Processing for minutes to hours)
     *   - a visitor who uploads, closes the tab and comes back the next morning
     *     to type the message (the `expires_at` on the ROOM is measured in days;
     *     the ATTACHMENT ticket is not the thing keeping their link alive)
     *   - a support agent preparing a file before the customer replies
     * and it still bounds growth to one day's uploads per compromised code
     * rather than "forever", which is what `finish()` setting expires_at = NULL
     * left behind. Shorter would start eating real customer files; longer stops
     * meaningfully bounding anything.
     */
    public const PUBLIC_CHAT_ORPHAN_GRACE_HOURS = 24;

    public function handle(): void
    {
        $this->purgeExpiredPending();
        $this->purgeUnreferencedPublicChat();
    }

    /**
     * The original sweep, unchanged: a ticket was minted, nothing was ever PUT,
     * the 1h `expires_at` passed. Row and object both go.
     */
    private function purgeExpiredPending(): void
    {
        $purged = 0;

        Attachment::withoutGlobalScopes()
            ->where('status', AttachmentStatus::Pending->value)
            ->where('expires_at', '<', now())
            ->chunkById(500, function ($stale) use (&$purged) {
                /** @var FilesystemAdapter $disk */
                $disk = Storage::disk(config('filesystems.default'));

                foreach ($stale as $attachment) {
                    try {
                        $disk->delete($attachment->storage_key);

                        if ($attachment->multipart_upload_id !== null) {
                            (new S3Multipart)->abort($disk, $attachment->storage_key, $attachment->multipart_upload_id);
                        }
                    } catch (\Throwable $e) {
                        Log::warning('media.purge_failed', ['attachment_id' => $attachment->id, 'error' => $e->getMessage()]);
                    }

                    $attachment->forceDelete();
                    $purged++;
                }
            });

        if ($purged > 0) {
            Log::info('media.expired_uploads_purged', ['count' => $purged]);
        }
    }

    /**
     * DEC-073 — UNBOUNDED ANONYMOUS STORAGE GROWTH.
     *
     * ==== THE HOLE ==========================================================
     * purgeExpiredPending() matches `status = pending AND expires_at < now()`.
     * But UploadService::finish() sets status = Uploaded AND expires_at = NULL.
     * A completed upload that is never spent on a message therefore matches
     * NOTHING, in either sweep, ever. On the internal surface that is merely
     * untidy — the uploader is a known, rate-limited, revocable member. On the
     * PUBLIC surface it is a resource-exhaustion primitive: anyone holding one
     * /support/<code> link can mint a ticket, PUT the bytes, call complete, and
     * never send a message — ten times a minute (throttle:pchat-visitor-upload),
     * at up to upload.file.max_bytes each, with no account, forever.
     *
     * ==== WHAT IT MAY TOUCH =================================================
     * Exactly two conditions, and both are necessary:
     *   1. public_chat_room_id IS NOT NULL. This is the partition column, and
     *      "internal" IS defined as this column being NULL (DEC-068). Scoping
     *      the sweep to it is what makes "never touches an internal attachment"
     *      a structural property rather than a promise. It covers the API-225
     *      AGENT ticket as well as the API-213 visitor one: an agent's file
     *      uploaded into a customer room and never sent is the same orphan with
     *      the same lifetime, and the row is just as unreachable.
     *   2. referenced by NOTHING. All four pivots are checked, not just the
     *      public-chat one. public_chat_message_attachments is the pivot that
     *      can actually hold one of these rows; the other three are asserted
     *      because the cost of the extra NOT EXISTS is nil and the cost of
     *      being wrong is deleting a file out from under a live message.
     *
     * created_at, never updated_at: `updated_at` moves when ProcessAttachment
     * writes back dimensions or the scan result, so an attacker who could keep
     * a row being touched could hold it out of the sweep indefinitely.
     * created_at is stamped once and by us.
     *
     * Deleted rows are hard-deleted along with original + derived objects. A
     * soft delete would leave the bytes — which are the entire problem.
     */
    private function purgeUnreferencedPublicChat(): void
    {
        $cutoff = now()->subHours(self::PUBLIC_CHAT_ORPHAN_GRACE_HOURS);
        $purged = 0;
        $bytes = 0;

        Attachment::withoutGlobalScopes()
            ->whereNotNull('public_chat_room_id')
            ->whereIn('status', self::reclaimableStatuses())
            ->where('created_at', '<', $cutoff)
            ->tap(fn ($q) => self::whereUnreferenced($q))
            ->chunkById(500, function ($orphans) use (&$purged, &$bytes) {
                /** @var FilesystemAdapter $disk */
                $disk = Storage::disk(config('filesystems.default'));

                foreach ($orphans as $attachment) {
                    // ==== THE ROW GOES FIRST, AND CONDITIONALLY ============
                    // The SELECT above and this delete are not one atomic act:
                    // a visitor can claim the attachment in between —
                    // PublicChatMessageWriter::claimAttachments takes
                    // lockForUpdate on this very row, inserts the pivot and
                    // commits. Deleting the objects first and the row
                    // unconditionally would leave a live message pointing at
                    // bytes that no longer exist.
                    //
                    // Re-asserting the four NOT EXISTS inside the DELETE closes
                    // it as a DATABASE GUARANTEE rather than a check: the
                    // statement blocks on the claim's row lock, re-evaluates
                    // after that transaction commits, and affects 0 rows. We
                    // then skip the objects entirely and the message keeps its
                    // file. The clauses come from the same whereUnreferenced()
                    // the SELECT used, so the two cannot drift.
                    $deleted = Attachment::withoutGlobalScopes()
                        ->whereKey($attachment->id)
                        ->tap(fn ($q) => self::whereUnreferenced($q))
                        ->delete();

                    if ($deleted === 0) {
                        continue; // claimed while we were looking away
                    }

                    // A Ready row has derived objects (thumb_sm/thumb_md/poster)
                    // that cost as much as the original. Deleting only
                    // storage_key would reclaim the row and leave the bytes —
                    // the exact failure this sweep exists to fix.
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
            Log::info('media.public_chat_orphans_purged', [
                'count' => $purged,
                'bytes' => $bytes,
                'grace_hours' => self::PUBLIC_CHAT_ORPHAN_GRACE_HOURS,
            ]);
        }
    }

    /**
     * The FINISHED states this sweep may reclaim.
     *
     * `pending` belongs to the OTHER sweep — it has a real expires_at and is
     * matched there. `deleted` is a tombstone whose bytes PurgeAttachmentFiles
     * already reclaimed; removing that row here would erase the record of the
     * deletion.
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
     * "Referenced by nothing", as ONE definition used by both the SELECT that
     * finds orphans and the DELETE that removes them. Written once on purpose:
     * if the two ever disagreed, the gap between them would be exactly the race
     * the conditional delete exists to close.
     *
     * All four pivots, not just the public-chat one.
     * public_chat_message_attachments is the pivot that can actually hold one of
     * these rows; the other three are asserted because the extra NOT EXISTS
     * costs nothing and being wrong means deleting a file out from under a live
     * message.
     *
     * @param  Builder<Attachment>  $query
     */
    private static function whereUnreferenced($query): void
    {
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
