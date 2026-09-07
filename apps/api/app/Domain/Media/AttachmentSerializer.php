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

        $derived = $attachment->derived ?? [];
        $urls = [
            'original' => $this->mediaUrls->temporaryGetUrl($disk, $attachment->storage_key),
            'thumb_sm' => isset($derived['thumb_sm']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_sm']) : null,
            'thumb_md' => isset($derived['thumb_md']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_md']) : null,
            'poster' => isset($derived['poster']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['poster']) : null,
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
            'urls_expire_at' => now()->addMinutes(self::URL_TTL_MINUTES)->toIso8601String(),
        ];
    }
}
