<?php

namespace App\Domain\LinkPreview;

/** Seam: tests inject a fake so nothing touches real DNS. */
interface DnsResolver
{
    /**
     * Every A and AAAA address for the host (empty array = unresolvable).
     *
     * @return list<string>
     */
    public function resolve(string $host): array;
}
