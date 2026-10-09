<?php

namespace App\Domain\LinkPreview;

/**
 * FR-MSG-013 / DEC-100 / B3 — the only code allowed to make an outbound request
 * for a user-supplied URL.
 *
 * Every HOP (the first request and each redirect) is validated from scratch:
 * scheme, userinfo, port, internal/blocked host, then BOTH A and AAAA answers must
 * all be public. The request then goes to the validated address, pinned, so a
 * second DNS answer can never be used. Anything unresolvable is blocked.
 *
 * Failures are returned as FetchResult::fail(code); the code is for logs and
 * must never be shown to a client (the endpoint answers a uniform "none").
 */
class SafeUrlFetcher
{
    public const MAX_REDIRECTS = 3;

    public const HTML_MAX_BYTES = 524288;   // 512 KB

    public const IMAGE_MAX_BYTES = 2097152; // 2 MB

    public const OVERALL_TIMEOUT = 10;

    public const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

    public const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    private const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

    private readonly HostPolicy $policy;

    private readonly DnsResolver $resolver;

    private readonly HttpTransport $transport;

    /** Nullable seams so the container can build the real thing and tests can inject fakes. */
    private readonly int $overallTimeout;

    private bool $ownIpsLoaded = false;

    public function __construct(?HostPolicy $policy = null, ?DnsResolver $resolver = null, ?HttpTransport $transport = null, int $overallTimeout = self::OVERALL_TIMEOUT)
    {
        $this->overallTimeout = $overallTimeout;
        $this->policy = $policy ?? HostPolicy::fromApp();
        $this->resolver = $resolver ?? new SystemDnsResolver;
        $this->transport = $transport ?? new CurlTransport;
    }

    public function fetchHtml(string $url): FetchResult
    {
        return $this->fetch($url, self::HTML_TYPES, self::HTML_MAX_BYTES, '</head>', 'text/html,application/xhtml+xml', false);
    }

    public function fetchImage(string $url): FetchResult
    {
        return $this->fetch($url, self::IMAGE_TYPES, self::IMAGE_MAX_BYTES, null, 'image/jpeg,image/png,image/webp,image/gif', true);
    }

    /**
     * @param  list<string>  $types
     */
    private function fetch(string $url, array $types, int $maxBytes, ?string $stopAt, string $accept, bool $failIfTruncated): FetchResult
    {
        $deadline = microtime(true) + $this->overallTimeout;
        $current = $url;

        for ($hop = 0; $hop <= self::MAX_REDIRECTS; $hop++) {
            $parts = $this->policy->parse($current);
            if (! $parts['ok']) {
                return FetchResult::fail('invalid_'.$parts['reason']);
            }
            $host = $parts['host'];
            // R18 on EVERY hop: a redirect may land on a one-time link that a GET would consume.
            if (HostPolicy::looksSensitive($parts['path'], $parts['query'])) {
                return FetchResult::fail('sensitive');
            }
            if ($this->policy->isInternalHost($host)) {
                return FetchResult::fail('internal_host');
            }
            if ($this->policy->isBlockedHost($host)) {
                return FetchResult::fail('blocked_host');
            }

            $this->learnOwnIps();
            // Resolve exactly once per hop; a literal needs no DNS. The overall deadline is
            // enforced right after: a resolver that overruns it ends the fetch before any request.
            $ips = $this->policy->isIpLiteral($host) ? [$host] : $this->resolver->resolve($host);
            if ($ips === []) {
                return FetchResult::fail('dns');
            }
            foreach ($ips as $ip) {
                if (! HostPolicy::isPublicIp($ip)) {
                    return FetchResult::fail('blocked_ip'); // one private answer poisons the set
                }
                if ($this->policy->isOwnIp($ip)) {
                    return FetchResult::fail('own_ip'); // hairpin to our own edge / egress address
                }
            }
            $pin = $this->preferV4($ips);

            $remaining = (int) ceil($deadline - microtime(true));
            if ($remaining <= 0) {
                return FetchResult::fail('timeout');
            }

            try {
                $res = $this->transport->get($parts['url'], $host, $parts['port'], $pin, [
                    'maxBytes' => $maxBytes,
                    'stopAt' => $stopAt,
                    'allowedTypes' => $types,
                    'timeout' => min(5, $remaining),
                    'connectTimeout' => min(3, $remaining),
                    'accept' => $accept,
                ]);
            } catch (\Throwable) {
                return FetchResult::fail('transport');
            }
            if ($res->failed) {
                return FetchResult::fail('transport');
            }

            if (in_array($res->status, self::REDIRECT_STATUSES, true)) {
                $location = $res->headers['location'] ?? '';
                $next = $location === '' ? null : HostPolicy::resolveReference($current, $location);
                if ($next === null) {
                    return FetchResult::fail('bad_redirect');
                }
                $nextParts = $this->policy->parse($next);
                if (! $nextParts['ok']) {
                    return FetchResult::fail('invalid_'.$nextParts['reason']);
                }
                if ($parts['scheme'] === 'https' && $nextParts['scheme'] === 'http') {
                    return FetchResult::fail('downgrade');
                }
                $current = $nextParts['url'];

                continue; // next loop iteration re-validates the new hop in full
            }

            if ($res->status !== 200) {
                return FetchResult::fail('status');
            }
            $encoding = strtolower($res->headers['content-encoding'] ?? 'identity');
            if ($encoding !== 'identity' && $encoding !== '') {
                return FetchResult::fail('encoding'); // we asked for identity; refuse surprises (zip bombs)
            }
            $ctype = strtolower(trim(explode(';', $res->headers['content-type'] ?? '')[0]));
            if (! in_array($ctype, $types, true)) {
                return FetchResult::fail('content_type');
            }
            $declared = $res->headers['content-length'] ?? null;
            if ($failIfTruncated && ($res->truncated || strlen($res->body) > $maxBytes || ($declared !== null && ctype_digit($declared) && (int) $declared > $maxBytes))) {
                return FetchResult::fail('too_large');
            }
            $body = $res->body;
            if (strlen($body) > $maxBytes) {
                $body = substr($body, 0, $maxBytes); // HTML: only the head matters
            }
            $charset = null;
            if (preg_match('/charset=["\']?([A-Za-z0-9_\-:.]+)/i', $res->headers['content-type'] ?? '', $m) === 1) {
                $charset = $m[1];
            }

            return FetchResult::success($current, $body, $ctype, $charset);
        }

        return FetchResult::fail('too_many_redirects');
    }

    /** Once per fetcher: what our own hostnames resolve to is off limits for ANY hostname. */
    private function learnOwnIps(): void
    {
        if ($this->ownIpsLoaded) {
            return;
        }
        $this->ownIpsLoaded = true;
        foreach ($this->policy->internalHosts() as $h) {
            try {
                $this->policy->addOwnIps($this->resolver->resolve($h));
            } catch (\Throwable) {
                // unresolvable own name: nothing to learn
            }
        }
    }

    /** @param list<string> $ips */
    private function preferV4(array $ips): string
    {
        foreach ($ips as $ip) {
            if (! str_contains($ip, ':')) {
                return $ip;
            }
        }

        return $ips[0];
    }
}
