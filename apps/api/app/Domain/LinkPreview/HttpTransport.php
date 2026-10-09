<?php

namespace App\Domain\LinkPreview;

/**
 * Seam for ONE HTTP GET against an already-validated, already-pinned address.
 * The transport never resolves names and never follows redirects.
 */
interface HttpTransport
{
    /**
     * @param  array{maxBytes:int, stopAt:?string, allowedTypes:list<string>, timeout:int, connectTimeout:int, accept:string}  $opts
     */
    public function get(string $url, string $host, int $port, string $ip, array $opts): TransportResponse;
}
