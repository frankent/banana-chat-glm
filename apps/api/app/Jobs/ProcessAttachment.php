<?php

namespace App\Jobs;

use App\Domain\Media\ClamAvScanner;
use App\Domain\Media\Ffmpeg;
use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Models\Attachment;
use App\Services\AuditLogger;
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
 * FR-MEDIA-001 worker step — uploaded → ready (or failed).
 *
 * Images: dimensions + webp thumbnails (thumb_sm ≤400px q80, thumb_md ≤1280px
 * q85, §FR-MEDIA-002). GIF keeps its original (thumb = first frame).
 *
 * kind=file gets a ClamAV scan (FR-MEDIA-006): infected → failed + object
 * deleted + audit `media.malware_detected`; clamd unreachable → ready with
 * `scan_result=skipped` + alert log (TC-MEDIA-034).
 *
 * Video (closes DEC-034): when ffmpeg/ffprobe are available (full-profile
 * image) the worker probes dimensions/duration and renders a poster frame
 * through the same GD webp thumb pipeline (EXIF-free). Host dev without
 * ffmpeg keeps the lite path — ready immediately, original only; originals
 * are never re-encoded (EXIF survives; every derived thumb is re-encoded).
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

            if ($attachment->kind === AttachmentKind::Video) {
                $this->processVideo($attachment);
            }

            if ($attachment->kind === AttachmentKind::File && $this->scanForMalware($attachment) === 'infected') {
                $this->quarantineInfected($attachment);

                return;
            }

            $attachment->forceFill(['status' => AttachmentStatus::Ready])->save();
        } catch (Throwable $e) {
            report($e);

            $attachment->forceFill(['status' => AttachmentStatus::Failed])->save();

            broadcast(new AttachmentProcessed($attachment->refresh()));

            return;
        }

        broadcast(new AttachmentProcessed($attachment->refresh()));
    }

    /**
     * FR-MEDIA-006 — returns the scan outcome and records it on the row.
     * Never throws on scanner trouble: `skipped` keeps the upload usable.
     */
    private function scanForMalware(Attachment $attachment): string
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        $stream = $disk->readStream($attachment->storage_key);

        try {
            $result = ClamAvScanner::fromConfig()->scanStream($stream);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }

        $outcome = $result === null ? 'skipped' : ($result ? 'clean' : 'infected');

        if ($outcome === 'skipped') {
            Log::warning('media.clamav_scan_skipped', [ // TC-MEDIA-034 alert
                'attachment_id' => $attachment->id,
                'workspace_id' => $attachment->workspace_id,
            ]);
        }

        $attachment->forceFill(['scan_result' => $outcome])->save();

        return $outcome;
    }

    private function quarantineInfected(Attachment $attachment): void
    {
        Storage::disk(config('filesystems.default'))->delete($attachment->storage_key);

        $attachment->forceFill(['status' => AttachmentStatus::Failed])->save();

        app(AuditLogger::class)->system(
            'media.malware_detected',
            $attachment->workspace_id,
            'attachment',
            $attachment->id,
            [
                'filename' => $attachment->original_name,
                'uploader_id' => $attachment->uploader_id,
                'scan_result' => $attachment->scan_result,
            ],
        );

        // TC-MEDIA-033 — uploader gets the attachment.failed event (EVT-030)
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
            $this->storeThumbs($attachment, $disk, $source, $info[0] ?? 0, $info[1] ?? 0, $isGif);
        } finally {
            imagedestroy($source);
        }
    }

    /**
     * DEC-034 (full profile) — probe dimensions/duration + poster frame via
     * ffmpeg, then reuse the GD webp thumb pipeline. No ffmpeg on the host
     * (lite) → silent no-op: the video goes ready, original only.
     */
    private function processVideo(Attachment $attachment): void
    {
        $ffmpeg = Ffmpeg::fromConfig();
        if (! $ffmpeg->available()) {
            return;
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        $local = tempnam(sys_get_temp_dir(), 'video');
        if ($local === false) {
            return;
        }

        try {
            $stream = $disk->readStream($attachment->storage_key);
            if (! is_resource($stream)) {
                return;
            }
            $dst = @fopen($local, 'wb');
            if ($dst === false) {
                fclose($stream);

                return;
            }
            stream_copy_to_stream($stream, $dst);
            fclose($stream);
            fclose($dst);

            $meta = $ffmpeg->probe($local);
            if ($meta !== null) {
                $attachment->forceFill([
                    'width' => $meta['width'] > 0 ? $meta['width'] : null,
                    'height' => $meta['height'] > 0 ? $meta['height'] : null,
                    'duration_ms' => $meta['duration_ms'] > 0 ? $meta['duration_ms'] : null,
                ])->save();
            }

            $posterBytes = $ffmpeg->posterFrame($local);
            if ($posterBytes === null) {
                return; // probe may still have filled dimensions — poster is best-effort
            }

            $source = @imagecreatefromstring($posterBytes);
            if ($source === false) {
                return;
            }

            try {
                $this->storeThumbs($attachment, $disk, $source, (int) imagesx($source), (int) imagesy($source), false);
            } finally {
                imagedestroy($source);
            }
        } finally {
            @unlink($local);
        }
    }

    /**
     * thumb_sm ≤400px q80 / thumb_md ≤1280px q85 webp (FR-MEDIA-002).
     */
    private function storeThumbs(Attachment $attachment, FilesystemAdapter $disk, \GdImage $source, int $w, int $h, bool $isGif): void
    {
        $derived = [];
        foreach ([['thumb_sm', 400, 80], ['thumb_md', 1280, 85]] as [$name, $maxSide, $quality]) {
            $thumb = $this->resize($source, $w, $h, $maxSide, $isGif);
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
