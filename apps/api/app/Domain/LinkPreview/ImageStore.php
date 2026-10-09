<?php

namespace App\Domain\LinkPreview;

use App\Domain\Media\MediaUrls;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Storage;

/**
 * FR-MSG-013 / B3 #5 — og:image bytes are validated by magic number, re-encoded
 * to WebP (max 640 px wide) and stored on OUR media disk. Viewers only ever
 * receive a signed URL to our copy; SVG and anything else is refused.
 */
class ImageStore
{
    public const MAX_BYTES = 2097152;

    public const MAX_WIDTH = 640;

    public const MAX_PIXELS = 16000000;

    public const URL_TTL_MINUTES = 55;

    private const ALLOWED_IMAGETYPES = [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP];

    public static function keyFor(string $urlHash): string
    {
        return 'link-previews/'.$urlHash.'.webp';
    }

    /** @return string|null the storage key, or null if the bytes are not an acceptable image */
    public function store(string $urlHash, string $bytes): ?string
    {
        if ($bytes === '' || strlen($bytes) > self::MAX_BYTES) {
            return null;
        }
        $info = @getimagesizefromstring($bytes); // magic bytes, not the Content-Type header
        if ($info === false || ! in_array($info[2], self::ALLOWED_IMAGETYPES, true)) {
            return null; // svg / html / anything else
        }
        [$w, $h] = $info;
        if ($w < 1 || $h < 1 || $w * $h > self::MAX_PIXELS) {
            return null; // decompression-bomb guard
        }

        $src = @imagecreatefromstring($bytes);
        if ($src === false) {
            return null;
        }
        try {
            if ($w > self::MAX_WIDTH) {
                $scaled = imagescale($src, self::MAX_WIDTH, max(1, (int) round($h * self::MAX_WIDTH / $w)));
                if ($scaled === false) {
                    return null;
                }
                $src = $scaled;
            }
            imagepalettetotruecolor($src);
            imagealphablending($src, true);
            imagesavealpha($src, true);
            ob_start();
            $ok = imagewebp($src, null, 80);
            $webp = (string) ob_get_clean();
        } finally {
            unset($src);
        }
        if (! $ok || $webp === '') {
            return null;
        }

        $key = self::keyFor($urlHash);
        $this->disk()->put($key, $webp);

        return $key;
    }

    /** Signed URL to OUR copy, or null if signing is unavailable. */
    public function signedUrl(string $key, \DateTimeInterface $expiresAt): ?string
    {
        try {
            return app(MediaUrls::class)->temporaryGetUrl($this->disk(), $key, $expiresAt, 'image/webp', 'preview.webp');
        } catch (\Throwable) {
            return null;
        }
    }

    public function delete(string $key): void
    {
        try {
            $this->disk()->delete($key);
        } catch (\Throwable) {
            // best effort
        }
    }

    private function disk(): FilesystemAdapter
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        return $disk;
    }
}
