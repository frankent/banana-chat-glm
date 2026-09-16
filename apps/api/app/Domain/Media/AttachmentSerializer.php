<?php

namespace App\Domain\Media;

use App\Models\Attachment;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Storage;

/**
 * §8.8 attachment shape — signed GET URLs valid for 1h (FR-MEDIA-004).
 */
class AttachmentSerializer
{
    public const URL_TTL_MINUTES = 60;

    public function __construct(
        private readonly MediaUrls $mediaUrls,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function toArray(Attachment $attachment): array
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        // FR-ROOM-012 — bound secret-room attachments presign no longer than
        // the room's deadline (see SecretAttachmentExpiry for the unbound case)
        $expiresAt = SecretAttachmentExpiry::expiresAt($attachment);

        $derived = $attachment->derived ?? [];

        // DEC-072 — every presigned GET carries a forced disposition and a
        // forced Content-Type. `original` uses the SERVER-SNIFFED mime on the
        // row (UploadService::finish writes the finfo result back over whatever
        // the client declared), so an object stored in MinIO as text/html is
        // replayed as an inert application/octet-stream download and can no
        // longer execute same-origin. The derived variants are produced by our
        // own ffmpeg/Imagick pipeline and are always webp — they are named
        // explicitly rather than inherited from the row, because a video's row
        // mime is video/mp4 while its poster is an image.
        $name = $attachment->original_name;
        $urls = [
            'original' => $this->mediaUrls->temporaryGetUrl($disk, $attachment->storage_key, $expiresAt, $attachment->mime_type, $name),
            'thumb_sm' => isset($derived['thumb_sm']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_sm'], $expiresAt, 'image/webp', $name) : null,
            'thumb_md' => isset($derived['thumb_md']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_md'], $expiresAt, 'image/webp', $name) : null,
            'poster' => isset($derived['poster']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['poster'], $expiresAt, 'image/webp', $name) : null,
        ];

        return [
            'id' => $attachment->id,
            'kind' => $attachment->kind->value,
            'status' => $attachment->status->value,
            'original_name' => $attachment->original_name,
            'mime_type' => $attachment->mime_type,
            'size_bytes' => (int) $attachment->size_bytes,
            'width' => $attachment->width,
            'height' => $attachment->height,
            'duration_ms' => $attachment->duration_ms,
            'urls' => $urls,
            'urls_expire_at' => $expiresAt->toIso8601String(),
        ];
    }
}
