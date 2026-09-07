<?php

namespace App\Jobs;

use App\Domain\Media\S3Multipart;
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

/**
 * FR-MEDIA-001 AC — pending uploads that never completed (1h expiry)
 * get their object/multipart session and row removed. TC-MEDIA-011.
 */
class PurgeExpiredUploads implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public function handle(): void
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
}
