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
        $urls = [
            'original' => $this->mediaUrls->temporaryGetUrl($disk, $attachment->storage_key, $expiresAt),
            'thumb_sm' => isset($derived['thumb_sm']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_sm'], $expiresAt) : null,
            'thumb_md' => isset($derived['thumb_md']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['thumb_md'], $expiresAt) : null,
            'poster' => isset($derived['poster']) ? $this->mediaUrls->temporaryGetUrl($disk, $derived['poster'], $expiresAt) : null,
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
