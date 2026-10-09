<?php

namespace App\Domain\LinkPreview;

/**
 * Real resolver. dns_get_record, not gethostbyname: A AND AAAA both come back
 * so a host with one public and one private address is caught by the caller.
 */
class SystemDnsResolver implements DnsResolver
{
    public function resolve(string $host): array
    {
        // dns_get_record has no timeout argument: bound glibc's resolver (2 s x 1 attempt per
        // nameserver) for this call; SafeUrlFetcher additionally enforces its overall deadline.
        $prev = getenv('RES_OPTIONS');
        putenv('RES_OPTIONS=timeout:2 attempts:1');
        try {
            $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        } finally {
            putenv($prev === false ? 'RES_OPTIONS' : 'RES_OPTIONS='.$prev);
        }
        if (! is_array($records)) {
            return [];
        }
        $ips = [];
        foreach ($records as $r) {
            if (isset($r['ip'])) {
                $ips[] = $r['ip'];
            } elseif (isset($r['ipv6'])) {
                $ips[] = $r['ipv6'];
            }
        }

        return array_values(array_unique($ips));
    }
}
