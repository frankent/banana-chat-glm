<?php

namespace App\Domain\Media;

use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\URL;

/**
 * URL plumbing for both disks:
 *
 * - s3 (MinIO/Spaces): native presigned PUT/GET (HMAC, offline).
 * - local: no native support → register callbacks producing signed API
 *   routes (`uploads.binary`, `attachments.file`) that stream through the
 *   API. Tests re-register these on Storage::fake instances.
 */
class MediaUrls
{
    public static function registerLocalCallbacks(FilesystemAdapter $disk): void
    {
        // NB: Laravel rebinds these closures to the FilesystemAdapter, so
        // self:: would resolve there — always reference MediaUrls explicitly.
        $disk->buildTemporaryUploadUrlsUsing(function (string $path, $expiration) {
            return [
                'url' => URL::temporarySignedRoute('uploads.binary', $expiration, [
                    'attachment' => MediaUrls::attachmentIdFromPath($path),
                ]),
            ];
        });

        $disk->buildTemporaryUrlsUsing(function (string $path, $expiration) {
            return URL::temporarySignedRoute('attachments.file', $expiration, [
                'attachment' => MediaUrls::attachmentIdFromPath($path),
                'variant' => MediaUrls::variantFromPath($path),
            ]);
        });
    }

    /**
     * Presigned GET for any storage key on the active disk (FR-MEDIA-004: 1h).
     */
    public function temporaryGetUrl(FilesystemAdapter $disk, string $key, int $minutes = AttachmentSerializer::URL_TTL_MINUTES): string
    {
        return $disk->temporaryUrl($key, now()->addMinutes($minutes));
    }

    /**
     * Storage keys look like ws/{wid}/att/{id}/{variant}.
     */
    public static function attachmentIdFromPath(string $path): string
    {
        $segments = explode('/', $path);

        return $segments[3] ?? throw new \InvalidArgumentException('not an attachment key: '.$path);
    }

    public static function variantFromPath(string $path): string
    {
        return explode('/', $path)[4] ?? 'original';
    }
}
