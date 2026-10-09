<?php

namespace App\Domain\LinkPreview;

class TransportResponse
{
    /**
     * @param  array<string,string>  $headers  lowercase names, last value wins
     */
    public function __construct(
        public readonly int $status,
        public readonly array $headers = [],
        public readonly string $body = '',
        public readonly bool $truncated = false,
        public readonly bool $failed = false,
    ) {}

    public static function failure(): self
    {
        return new self(0, [], '', false, true);
    }
}
