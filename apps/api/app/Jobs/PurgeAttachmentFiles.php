<?php

namespace App\Jobs;

use App\Enums\AttachmentStatus;
use App\Models\Attachment;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * FR-MEDIA-006 — remove original + derived objects 24h after the message
 * that referenced them was deleted. Best-effort with retries (the row flips
 * to `deleted` regardless; failures are logged for admin follow-up).
 */
class PurgeAttachmentFiles implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries = 5;

    /**
     * @param  list<string>  $attachmentIds
     */
    public function __construct(
        public readonly array $attachmentIds,
    ) {}

    public function handle(): void
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        $failures = [];

        $attachments = Attachment::withoutGlobalScopes()
            ->whereKey($this->attachmentIds)
            ->get();

        foreach ($attachments as $attachment) {
            try {
                $keys = array_values(array_filter(array_merge(
                    [$attachment->storage_key],
                    array_values($attachment->derived ?? []),
                )));

                foreach ($keys as $key) {
                    if ($disk->exists($key)) {
                        $disk->delete($key);
                    }
                }

                $attachment->forceFill(['status' => AttachmentStatus::Deleted])->save();
            } catch (Throwable $e) {
                report($e);
                $failures[] = $attachment->id;
            }
        }

        if ($failures !== []) {
            Log::warning('media.delete_failed', ['attachment_ids' => $failures]);
            $this->release(now()->addMinutes(30)->diffInSeconds(now()));
        }
    }
}
