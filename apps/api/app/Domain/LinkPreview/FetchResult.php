<?php

namespace App\Domain\LinkPreview;

class FetchResult
{
    private function __construct(
        public readonly bool $ok,
        public readonly string $reason,
        public readonly ?string $finalUrl = null,
        public readonly string $body = '',
        public readonly ?string $contentType = null,
        public readonly ?string $charset = null,
    ) {}

    public static function success(string $finalUrl, string $body, string $contentType, ?string $charset): self
    {
        return new self(true, 'ok', $finalUrl, $body, $contentType, $charset);
    }

    /** $reason is a short internal code for logs only; it never reaches an API response. */
    public static function fail(string $reason): self
    {
        return new self(false, $reason);
    }
}
