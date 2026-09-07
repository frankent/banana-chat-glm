<?php

namespace App\Jobs;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Models\Attachment;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * FR-MEDIA-001 worker step — uploaded → ready (or failed).
 *
 * Images: dimensions + webp thumbnails (thumb_sm ≤400px q80, thumb_md ≤1280px
 * q85, §FR-MEDIA-002). GIF keeps its original (thumb = first frame).
 *
 * Lite build (DEC-034): no ffmpeg on the worker host → video skips poster/
 * duration/dimensions and goes straight to ready; originals are not re-encoded
 * (EXIF survives on the original; thumbnails are EXIF-free by re-encoding).
 */
class ProcessAttachment implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries = 3;

    public function __construct(
        public readonly Attachment $attachment,
    ) {}

    public function handle(): void
    {
        // another worker may have finished it already (idempotency)
        $attachment = Attachment::withoutGlobalScopes()->findOrFail($this->attachment->id);
        if ($attachment->status !== AttachmentStatus::Uploaded) {
            return;
        }

        try {
            $attachment->forceFill(['status' => AttachmentStatus::Processing])->save();

            if (in_array($attachment->kind, [AttachmentKind::Image, AttachmentKind::Avatar], true)) {
                $this->processImage($attachment);
            }
            // video: no ffmpeg in this build (DEC-034) — original only, ready now.
            // file: nothing to derive — ready now.

            $attachment->forceFill(['status' => AttachmentStatus::Ready])->save();
        } catch (Throwable $e) {
            report($e);

            $attachment->forceFill(['status' => AttachmentStatus::Failed])->save();

            broadcast(new AttachmentProcessed($attachment->refresh()));

            return;
        }

        broadcast(new AttachmentProcessed($attachment->refresh()));
    }

    private function processImage(Attachment $attachment): void
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        $bytes = $disk->get($attachment->storage_key);
        if ($bytes === null) {
            throw new \RuntimeException('original object missing: '.$attachment->storage_key);
        }

        $info = @getimagesizefromstring($bytes);
        if ($info !== false) {
            $attachment->forceFill([
                'width' => $info[0],
                'height' => $info[1],
            ])->save();
        }

        // HEIC/HEIF: GD cannot decode — dimensions/thumbs skipped, still usable
        if (str_starts_with($attachment->mime_type, 'image/heic') || str_starts_with($attachment->mime_type, 'image/heif')) {
            return;
        }

        $source = @imagecreatefromstring($bytes);
        if ($source === false) {
            return; // undecodable but valid bytes — keep, no thumbs
        }

        try {
            $isGif = $attachment->mime_type === 'image/gif'; // keep animation: never resize the original

            $derived = [];
            foreach ([['thumb_sm', 400, 80], ['thumb_md', 1280, 85]] as [$name, $maxSide, $quality]) {
                $thumb = $this->resize($source, $info[0] ?? 0, $info[1] ?? 0, $maxSide, $isGif);
                if ($thumb === null) {
                    continue; // smaller than target / gif — use first frame unscaled
                }

                ob_start();
                imagewebp($thumb, null, $quality);
                $webp = ob_get_clean();
                if ($webp === false || $webp === '') {
                    continue;
                }

                $key = sprintf('ws/%s/att/%s/%s', $attachment->workspace_id, $attachment->id, $name);
                $disk->put($key, $webp, 'private');
                $derived[$name] = $key;

                if ($thumb !== $source) {
                    imagedestroy($thumb);
                }
            }

            if ($derived !== []) {
                $attachment->forceFill(['derived' => $derived])->save();
            }
        } finally {
            imagedestroy($source);
        }
    }

    /**
     * Longest side ≤ $maxSide, webp. Returns null target == no resource created
     * (caller skips). Animated GIFs: thumb is the first frame, unscaled.
     */
    private function resize(\GdImage $source, int $w, int $h, int $maxSide, bool $isGif): ?\GdImage
    {
        if ($w <= 0 || $h <= 0) {
            return null;
        }

        $longest = max($w, $h);
        if ($longest <= $maxSide || $isGif) {
            return $source; // already small enough — encode as-is
        }

        $scale = $maxSide / $longest;
        $tw = max(1, (int) round($w * $scale));
        $th = max(1, (int) round($h * $scale));

        $thumb = imagecreatetruecolor($tw, $th);
        if ($thumb === false) {
            return null;
        }

        // PNG/GIF transparency → flat white (thumbs only)
        imagefill($thumb, 0, 0, imagecolorallocate($thumb, 255, 255, 255));
        imagecopyresampled($thumb, $source, 0, 0, 0, 0, $tw, $th, $w, $h);

        return $thumb;
    }
}
