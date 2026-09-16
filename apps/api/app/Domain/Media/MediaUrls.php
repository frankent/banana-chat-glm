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

        // DEC-072 — the third argument Laravel passes here is the S3 response-
        // override array from temporaryGetUrl(). It is deliberately IGNORED on
        // this disk: the local URL is a signed route into
        // UploadController::file, which applies the very same InlineSafety
        // predicate on the response itself. Baking the disposition into the
        // signed route params would give two places to change and one to
        // forget.
        $disk->buildTemporaryUrlsUsing(function (string $path, $expiration) {
            return URL::temporarySignedRoute('attachments.file', $expiration, [
                'attachment' => MediaUrls::attachmentIdFromPath($path),
                'variant' => MediaUrls::variantFromPath($path),
            ]);
        });
    }

    /**
     * Presigned GET for any storage key on the active disk (FR-MEDIA-004: 1h).
     *
     * ==== DEC-072 — THE LAYER THAT PROTECTS ALREADY-STORED OBJECTS =========
     * Production serves MinIO under the app's OWN origin, and MinIO replays the
     * `Content-Type` the uploading client chose on its presigned PUT. Without
     * the overrides below, an object stored as `text/html` or `image/svg+xml`
     * comes back as a same-origin DOCUMENT and its script runs with the chat
     * app's session — stored XSS, reachable by an unauthenticated public-chat
     * visitor and by any workspace member alike.
     *
     * The two `Response*` parameters are part of the SIGNED query string, so a
     * holder of the URL cannot strip them without invalidating the signature.
     * That is what makes this a control rather than a suggestion, and why it is
     * the only one of the three layers that helps for bytes already in the
     * bucket: the deny list and the sniff both act at upload time and cannot
     * reach backwards.
     *
     * $mime MUST be the server-sniffed `attachments.mime_type`, never anything
     * the client declared. It is optional only so the signature stays
     * compatible, and its default is the FAIL-CLOSED answer: a caller that
     * forgets it gets `attachment` + `application/octet-stream`, which is
     * inert, rather than an inline render of an unknown type.
     */
    public function temporaryGetUrl(
        FilesystemAdapter $disk,
        string $key,
        int|\DateTimeInterface $expiration = AttachmentSerializer::URL_TTL_MINUTES,
        ?string $mime = null,
        ?string $filename = null,
    ): string {
        return $disk->temporaryUrl(
            $key,
            is_int($expiration) ? now()->addMinutes($expiration) : $expiration,
            InlineSafety::s3ResponseOverrides($mime, $filename),
        );
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
