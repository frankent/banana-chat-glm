<?php

namespace App\Domain\LinkPreview;

/**
 * Real transport. The IP was validated by SafeUrlFetcher and is pinned with
 * CURLOPT_RESOLVE so cURL never performs its own lookup (DNS-rebinding defence);
 * Host header + SNI stay the original hostname because the URL is unchanged.
 */
class CurlTransport implements HttpTransport
{
    /** "host:port:ip" — IPv6 addresses go in brackets. */
    public static function resolveEntry(string $host, int $port, string $ip): string
    {
        $ip = trim($ip, '[]');

        return $host.':'.$port.':'.(str_contains($ip, ':') ? '['.$ip.']' : $ip);
    }

    /**
     * @return array<int,mixed>
     */
    public static function baseOptions(string $url, string $host, int $port, string $ip, array $opts): array
    {
        return [
            CURLOPT_URL => $url,
            CURLOPT_RESOLVE => [self::resolveEntry($host, $port, $ip)],
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_PROXY => '',
            CURLOPT_NOPROXY => '*',
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => $opts['connectTimeout'],
            CURLOPT_TIMEOUT => $opts['timeout'],
            CURLOPT_USERAGENT => 'BananaChatLinkPreview/1.0',
            CURLOPT_HTTPHEADER => ['Accept: '.$opts['accept'], 'Accept-Encoding: identity'],
            CURLOPT_COOKIEFILE => '',
            CURLOPT_COOKIEJAR => '',
            CURLOPT_HTTPAUTH => CURLAUTH_NONE,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HTTP09_ALLOWED => false,
        ];
    }

    public function get(string $url, string $host, int $port, string $ip, array $opts): TransportResponse
    {
        // Defence in depth for the DNS pin: CURLOPT_RESOLVE is keyed on $host:$port, but cURL
        // uses the host it parses from $url (percent-decoded). If the two ever differ the pin is
        // bypassed and cURL does its own lookup, so refuse outright.
        $u = parse_url($url);
        $urlHost = is_array($u) && isset($u['host']) ? strtolower(trim($u['host'], '[]')) : null;
        $authority = preg_split('/[\/?#]/', explode('://', $url, 2)[1] ?? '', 2)[0];
        $urlPort = $u['port'] ?? (($u['scheme'] ?? '') === 'https' ? 443 : 80);
        if ($urlHost === null || str_contains($authority, '%') || str_contains($authority, '@')
            || isset($u['user']) || $urlHost !== strtolower(trim($host, '[]')) || $urlPort !== $port) {
            return TransportResponse::failure();
        }

        $headers = [];
        $body = '';
        $truncated = false;
        $aborted = false;
        $lineStatus = 0;
        $max = $opts['maxBytes'];
        $stopAt = $opts['stopAt'];
        $allowed = $opts['allowedTypes'];

        $ch = curl_init();
        $options = self::baseOptions($url, $host, $port, $ip, $opts) + [
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$headers, &$aborted, &$lineStatus, $allowed) {
                $len = strlen($line);
                if (str_starts_with($line, 'HTTP/')) {
                    $headers = []; // new response block (e.g. after 1xx)
                    $lineStatus = (int) (explode(' ', $line)[1] ?? 0);

                    return $len;
                }
                if (str_contains($line, ':')) {
                    [$k, $v] = explode(':', $line, 2);
                    $headers[strtolower(trim($k))] = trim($v);
                }
                // Blank line = end of headers: refuse bodies we would discard anyway.
                if (trim($line) === '' && isset($headers['content-type']) && $allowed !== []) {
                    $type = strtolower(trim(explode(';', $headers['content-type'])[0]));
                    if ($lineStatus >= 200 && $lineStatus < 300 && ! in_array($type, $allowed, true)) {
                        $aborted = true;

                        return 0;
                    }
                }

                return $len;
            },
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$truncated, $max, $stopAt) {
                $remaining = $max - strlen($body);
                if (strlen($chunk) > $remaining) {
                    $body .= substr($chunk, 0, max(0, $remaining));
                    $truncated = true;

                    return 0; // abort: hard cap reached
                }
                $body .= $chunk;
                if ($stopAt !== null && stripos($body, $stopAt) !== false) {
                    return 0; // got what we need (</head>)
                }

                return strlen($chunk);
            },
        ];
        curl_setopt_array($ch, $options);
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $errno = curl_errno($ch);
        curl_close($ch);

        // Aborting from a callback yields CURLE_WRITE_ERROR (23) / ABORTED_BY_CALLBACK (42): expected.
        $deliberate = $truncated || $aborted || ($stopAt !== null && stripos($body, $stopAt) !== false);
        if ($ok === false && ! $deliberate && $errno !== 0) {
            return TransportResponse::failure();
        }
        if ($aborted) {
            return new TransportResponse($status, $headers, '', false, false);
        }

        return new TransportResponse($status, $headers, $body, $truncated);
    }
}
