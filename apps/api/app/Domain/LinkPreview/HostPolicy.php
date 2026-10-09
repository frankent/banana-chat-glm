<?php

namespace App\Domain\LinkPreview;

use App\Services\SettingsService;

/**
 * FR-MSG-013 / DEC-100 — the SSRF decision table for the link-preview fetcher.
 * Pure: no DNS, no network, no framework state, so every rule is unit-testable.
 *
 * Fail-closed throughout: anything this class cannot positively classify as a
 * public, canonical, http(s) host on port 80/443 is refused.
 */
class HostPolicy
{
    /** IPv4 ranges that are never public (B3 SafeUrlFetcher #1). */
    private const BLOCKED_V4 = [
        '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
        '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15',
        '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
    ];

    /**
     * IPv6 ranges. ::ffff:0:0/96 is handled by unwrapping (the embedded v4 is
     * re-tested); the rest are refused outright. ::/96 (IPv4-compatible), 2002::/16
     * (6to4) and 2001::/32 (Teredo) are additions beyond B3: all three embed an
     * IPv4 address a resolver could aim at the private network.
     */
    private const BLOCKED_V6 = [
        '::/128', '::1/128', '::/96', '64:ff9b::/96', 'fc00::/7', 'fe80::/10', 'ff00::/8',
        '2001:db8::/32', '2002::/16', '2001::/32',
    ];

    private const SUSPICIOUS_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'];

    /** @var list<string> */
    private array $internalHosts;

    /** @var list<string> */
    private array $blockedHosts;

    /** @var list<string> binary (inet_pton) addresses that are ours: egress / edge IPs */
    private array $ownIps = [];

    /**
     * @param  list<string>  $internalHosts  hosts of THIS app (exact match) — never fetched
     * @param  list<string>  $blockedHosts  ops deny list (host or any subdomain of it)
     * @param  list<string>  $ownIps  our own public / egress addresses (hairpin deny, even though public)
     */
    public function __construct(array $internalHosts = [], array $blockedHosts = [], array $ownIps = [])
    {
        foreach ($ownIps as $ip) {
            $this->addOwnIp((string) $ip);
        }
        $this->internalHosts = array_values(array_filter(array_map([self::class, 'hostOf'], $internalHosts)));
        $this->blockedHosts = array_values(array_filter(array_map([self::class, 'hostOf'], $blockedHosts)));
    }

    /**
     * The production policy: this app's own hosts are internal (APP_URL, the
     * request host, every alias in config('app.web_origins') — env APP_WEB_ORIGINS,
     * comma separated; NOT a SettingsService key, that service only exposes its
     * DEFAULTS), plus the ops deny list and our own egress IPs
     * (config('app.own_ips') — env LINK_PREVIEW_OWN_IPS, comma separated).
     */
    public static function fromApp(?string $requestHost = null): self
    {
        $settings = app(SettingsService::class);
        $internal = [(string) config('app.url'), ...self::listOf(config('app.web_origins'))];
        if ($requestHost !== null && $requestHost !== '') {
            $internal[] = $requestHost;
        }

        return new self($internal, array_map('strval', $settings->array('link_preview.blocked_hosts')), self::listOf(config('app.own_ips')));
    }

    /** @return list<string> a config value that may be an array or a comma separated string */
    private static function listOf(mixed $value): array
    {
        if (is_string($value)) {
            $value = explode(',', $value);
        }
        if (! is_array($value)) {
            return [];
        }

        return array_values(array_filter(array_map(fn ($v) => trim((string) $v), $value), fn ($v) => $v !== ''));
    }

    private function addOwnIp(string $ip): void
    {
        $bin = @inet_pton(trim($ip, '[] '));
        if ($bin === false) {
            return;
        }
        if (strlen($bin) === 16 && str_starts_with($bin, str_repeat("\0", 10)."\xff\xff")) {
            $bin = substr($bin, 12); // ::ffff:a.b.c.d is the same host as a.b.c.d
        }
        $this->ownIps[] = $bin;
    }

    /** Hosts of this app (APP_URL, request host, aliases): the fetcher resolves them to learn our edge IPs. */
    public function internalHosts(): array
    {
        return $this->internalHosts;
    }

    /** Register addresses learnt at runtime (what our own hostnames resolve to). */
    public function addOwnIps(array $ips): void
    {
        foreach ($ips as $ip) {
            $this->addOwnIp((string) $ip);
        }
    }

    public function isOwnIp(string $ip): bool
    {
        $bin = @inet_pton(trim($ip, '[] '));
        if ($bin === false) {
            return false;
        }
        if (strlen($bin) === 16 && str_starts_with($bin, str_repeat("\0", 10)."\xff\xff")) {
            $bin = substr($bin, 12);
        }

        return in_array($bin, $this->ownIps, true);
    }

    /** Accepts "host", "host:port" or a full URL; returns the lowercase ASCII host. */
    private static function hostOf(mixed $value): ?string
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }
        $value = trim($value);
        $host = str_contains($value, '://') ? parse_url($value, PHP_URL_HOST) : preg_replace('/:\d+$/', '', $value);

        return is_string($host) && $host !== '' ? self::asciiHost($host) : null;
    }

    private static function asciiHost(string $host): ?string
    {
        $host = rtrim(strtolower(trim($host)), '.');
        if ($host === '') {
            return null;
        }
        if (preg_match('/[^\x20-\x7e]/', $host) === 1) {
            $ascii = function_exists('idn_to_ascii') ? idn_to_ascii($host, IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46) : false;

            return is_string($ascii) && $ascii !== '' ? strtolower($ascii) : null;
        }

        return $host;
    }

    /**
     * Validate and normalise an absolute URL for fetching.
     *
     * @return array{ok:bool, reason?:string, url?:string, scheme?:string, host?:string, port?:int, path?:string, query?:?string}
     */
    public function parse(string $url): array
    {
        $url = trim($url);
        if ($url === '' || strlen($url) > 2048 || preg_match('/[\x00-\x20\x7f\\\\]/', $url) === 1) {
            return ['ok' => false, 'reason' => 'url'];
        }
        $p = parse_url($url);
        if ($p === false || ! isset($p['scheme'], $p['host'])) {
            return ['ok' => false, 'reason' => 'url'];
        }
        $scheme = strtolower($p['scheme']);
        if ($scheme !== 'http' && $scheme !== 'https') {
            return ['ok' => false, 'reason' => 'scheme'];
        }
        if (isset($p['user']) || isset($p['pass']) || str_contains(preg_split('/[\/?#]/', explode('://', $url, 2)[1] ?? '', 2)[0], '@')) {
            return ['ok' => false, 'reason' => 'userinfo'];
        }
        $default = $scheme === 'https' ? 443 : 80;
        $port = $p['port'] ?? $default;
        if ($port !== 80 && $port !== 443) {
            return ['ok' => false, 'reason' => 'port'];
        }
        // libcurl percent-decodes the host AFTER we keyed CURLOPT_RESOLVE on the raw string,
        // so `a%2eb.evil.com` would dodge the pin and make cURL resolve (rebind) on its own.
        // No '%' in the authority, ever, and only DNS-label characters in a name host.
        $authority = preg_split('/[\/?#]/', explode('://', $url, 2)[1] ?? '', 2)[0];
        if (str_contains($authority, '%')) {
            return ['ok' => false, 'reason' => 'host'];
        }
        $host = self::asciiHost($p['host']);
        if ($host === null || (! str_contains($host, ':') && preg_match('/^[a-z0-9._-]+$/', $host) !== 1)) {
            return ['ok' => false, 'reason' => 'host'];
        }
        $check = $this->checkHostSyntax($host);
        if ($check !== null) {
            return ['ok' => false, 'reason' => $check];
        }
        $path = $p['path'] ?? '/';
        $path = $path === '' ? '/' : $path;
        $query = isset($p['query']) && $p['query'] !== '' ? $p['query'] : null;
        $hostForUrl = str_contains($host, ':') ? '['.trim($host, '[]').']' : $host;
        $norm = $scheme.'://'.$hostForUrl.($port === $default ? '' : ':'.$port).$path.($query !== null ? '?'.$query : '');

        return ['ok' => true, 'url' => $norm, 'scheme' => $scheme, 'host' => trim($host, '[]'), 'port' => $port, 'path' => $path, 'query' => $query];
    }

    /**
     * Syntax-level host rules: IP literals (any obfuscated v4 form is refused,
     * canonical ones are range-checked), localhost-ish names.
     */
    private function checkHostSyntax(string $host): ?string
    {
        if (str_starts_with($host, '[') || str_contains($host, ':')) {
            $ip = trim($host, '[]');
            if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
                return 'host';
            }

            return self::isPublicIp($ip) ? null : 'blocked_ip';
        }

        // Anything shaped like a number/hex/octal IPv4 form (1, 2130706433, 0x7f.1,
        // 0177.0.0.1, 127.1, 1.2.3.4.5 ...) — including the last label being numeric,
        // which libc/cURL would happily read as an address. Only a canonical dotted
        // quad is accepted, and then only when public.
        $labels = explode('.', $host);
        $last = end($labels);
        $numericish = preg_match('/^(0x[0-9a-f]*|\d+)$/i', $last) === 1;
        if ($numericish) {
            if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false || ! self::isCanonicalV4($host)) {
                return 'ip_literal';
            }

            return self::isPublicIp($host) ? null : 'blocked_ip';
        }

        if ($host === 'localhost' || ! str_contains($host, '.')) {
            return 'host';
        }
        foreach (self::SUSPICIOUS_SUFFIXES as $suffix) {
            if (str_ends_with($host, $suffix)) {
                return 'host';
            }
        }

        return null;
    }

    private static function isCanonicalV4(string $ip): bool
    {
        // FILTER_VALIDATE_IP already rejects leading zeros and >255; belt and braces.
        return preg_match('/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/', $ip) === 1;
    }

    public function isIpLiteral(string $host): bool
    {
        $host = trim($host, '[]');

        return filter_var($host, FILTER_VALIDATE_IP) !== false;
    }

    /** True only for an address that is routable on the public internet. */
    public static function isPublicIp(string $ip): bool
    {
        $ip = trim($ip, '[]');
        $bin = @inet_pton($ip);
        if ($bin === false) {
            return false;
        }
        if (strlen($bin) === 4) {
            return ! self::inAny($bin, self::BLOCKED_V4);
        }
        // IPv4-mapped (::ffff:a.b.c.d): judge the embedded v4 address.
        if (str_starts_with($bin, str_repeat("\0", 10)."\xff\xff")) {
            return self::isPublicIp(inet_ntop(substr($bin, 12)));
        }

        return ! self::inAny($bin, self::BLOCKED_V6);
    }

    /** @param list<string> $cidrs */
    private static function inAny(string $bin, array $cidrs): bool
    {
        foreach ($cidrs as $cidr) {
            [$net, $bits] = explode('/', $cidr);
            $netBin = inet_pton($net);
            if (strlen($netBin) !== strlen($bin)) {
                continue;
            }
            $bits = (int) $bits;
            $full = intdiv($bits, 8);
            if ($full > 0 && substr($bin, 0, $full) !== substr($netBin, 0, $full)) {
                continue;
            }
            $rem = $bits % 8;
            if ($rem !== 0) {
                $mask = (0xFF << (8 - $rem)) & 0xFF;
                if ((ord($bin[$full]) & $mask) !== (ord($netBin[$full]) & $mask)) {
                    continue;
                }
            }

            return true;
        }

        return false;
    }

    /** This app's own hosts: bearer-bearing paths (/support, /join), tickets and meetings live here. */
    public function isInternalHost(string $host): bool
    {
        $host = self::asciiHost($host) ?? '';

        return $host !== '' && in_array($host, $this->internalHosts, true);
    }

    /** Ops deny list: the host itself or any subdomain. */
    public function isBlockedHost(string $host): bool
    {
        $host = self::asciiHost($host) ?? '';
        foreach ($this->blockedHosts as $blocked) {
            if ($host === $blocked || str_ends_with($host, '.'.$blocked)) {
                return true;
            }
        }

        return false;
    }

    /**
     * R18 — a URL that looks like it carries a one-time secret is never unfurled:
     * a GET could consume a magic link / password reset. Conservative on purpose;
     * a false positive only costs a plain link.
     *
     * Token-looking = 64+ hex, or >=32 chars of [A-Za-z0-9_-] that mix letters and
     * digits with at most two '-'/'_' (hyphenated article slugs are not tokens),
     * in a path segment or a query value; or a secret-named query key with a value.
     */
    public static function looksSensitive(string $path, ?string $query): bool
    {
        $values = [];
        foreach (explode('/', rawurldecode($path)) as $segment) {
            $values[] = $segment;
        }
        if ($query !== null && $query !== '') {
            foreach (explode('&', $query) as $pair) {
                [$k, $v] = array_pad(explode('=', $pair, 2), 2, '');
                $v = rawurldecode($v);
                if ($v !== '' && preg_match('/(token|secret|sig|signature|password|passwd|otp|auth|code|key|reset|magic|session)/i', rawurldecode($k)) === 1) {
                    return true;
                }
                $values[] = $v;
            }
        }
        foreach ($values as $v) {
            if (preg_match('/^[0-9a-f]{32,}$/i', $v) === 1) {
                return true;
            }
            if (strlen($v) >= 32 && preg_match('/^[A-Za-z0-9_-]+$/', $v) === 1
                && preg_match('/[A-Za-z]/', $v) === 1 && preg_match('/\d/', $v) === 1
                && preg_match_all('/[-_]/', $v) <= 2) {
                return true;
            }
        }

        return false;
    }

    /** Resolve a (possibly relative) reference against an absolute base URL. */
    public static function resolveReference(string $base, string $ref): ?string
    {
        $ref = trim($ref);
        if ($ref === '' || preg_match('/[\x00-\x20\x7f\\\\]/', $ref) === 1) {
            return null;
        }
        $b = parse_url($base);
        if ($b === false || ! isset($b['scheme'], $b['host'])) {
            return null;
        }
        if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $ref) === 1) {
            return $ref; // absolute (scheme validated later by parse())
        }
        $origin = $b['scheme'].'://'.(str_contains($b['host'], ':') ? '['.trim($b['host'], '[]').']' : $b['host']).(isset($b['port']) ? ':'.$b['port'] : '');
        if (str_starts_with($ref, '//')) {
            return $b['scheme'].':'.$ref;
        }
        if (str_starts_with($ref, '/')) {
            return $origin.self::dotSegments($ref);
        }
        if (str_starts_with($ref, '?')) {
            return $origin.($b['path'] ?? '/').$ref;
        }
        $dir = preg_replace('#[^/]*$#', '', $b['path'] ?? '/');

        return $origin.self::dotSegments($dir.$ref);
    }

    private static function dotSegments(string $pathAndQuery): string
    {
        $q = '';
        if (($pos = strpos($pathAndQuery, '?')) !== false) {
            $q = substr($pathAndQuery, $pos);
            $pathAndQuery = substr($pathAndQuery, 0, $pos);
        }
        $out = [];
        foreach (explode('/', $pathAndQuery) as $seg) {
            if ($seg === '..') {
                if (count($out) > 1) {
                    array_pop($out); // never pop the leading '' (root)
                }
            } elseif ($seg !== '.') {
                $out[] = $seg;
            }
        }
        $path = implode('/', $out);

        return ($path === '' ? '/' : $path).$q;
    }
}
