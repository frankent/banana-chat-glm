<?php

use App\Domain\LinkPreview\CurlTransport;
use App\Domain\LinkPreview\DnsResolver;
use App\Domain\LinkPreview\HostPolicy;
use App\Domain\LinkPreview\HttpTransport;
use App\Domain\LinkPreview\ImageStore;
use App\Domain\LinkPreview\OgParser;
use App\Domain\LinkPreview\SafeUrlFetcher;
use App\Domain\LinkPreview\TransportResponse;
use Illuminate\Support\Facades\Storage;

/*
 * FR-MSG-013 / DEC-100 / API-241 — SSRF contract of SafeUrlFetcher (B3). Nothing here
 * touches the network: DNS and HTTP are fakes behind the DnsResolver / HttpTransport seams.
 */

class SufFakeResolver implements DnsResolver
{
    public int $calls = 0;

    /** @var list<string> */
    public array $hosts = [];

    /** @param array<string, list<string>|list<list<string>>> $map host => answer, or host => [answer1, answer2...] per call */
    public function __construct(public array $map = [], public bool $sequence = false) {}

    public function resolve(string $host): array
    {
        $this->calls++;
        $this->hosts[] = $host;
        $entry = $this->map[$host] ?? [];
        if ($this->sequence) {
            return $entry[min($this->calls - 1, count($entry) - 1)];
        }

        return $entry;
    }
}

class SufFakeTransport implements HttpTransport
{
    /** @var list<array{url:string, host:string, port:int, ip:string, opts:array}> */
    public array $calls = [];

    /** @param list<TransportResponse|Closure|Throwable> $script one entry per call */
    public function __construct(public array $script = []) {}

    public function get(string $url, string $host, int $port, string $ip, array $opts): TransportResponse
    {
        $this->calls[] = compact('url', 'host', 'port', 'ip', 'opts');
        $next = array_shift($this->script) ?? TransportResponse::failure();
        if ($next instanceof Throwable) {
            throw $next;
        }

        return $next instanceof Closure ? $next($url, $host, $port, $ip, $opts) : $next;
    }
}

function sufHtml(string $body = '<html><head><title>x</title></head></html>', array $h = []): TransportResponse
{
    return new TransportResponse(200, $h + ['content-type' => 'text/html; charset=utf-8'], $body);
}

function sufRedirect(string $to, int $status = 302): TransportResponse
{
    return new TransportResponse($status, ['location' => $to]);
}

function sufFetcher(?SufFakeResolver &$resolver = null, ?SufFakeTransport &$transport = null, array $dns = [], array $script = [], array $internal = [], array $blocked = []): SafeUrlFetcher
{
    $resolver = new SufFakeResolver($dns + ['example.com' => ['93.184.216.34'], 'cdn.example.org' => ['1.1.1.1']]);
    $transport = new SufFakeTransport($script);

    return new SafeUrlFetcher(new HostPolicy($internal, $blocked), $resolver, $transport);
}

// ---------------------------------------------------------------- TC-MSG-091
test('TC-MSG-091 every blocked IPv4/IPv6 literal is refused before any request', function (string $url) {
    $f = sufFetcher($r, $t, script: [sufHtml()]);
    $res = $f->fetchHtml($url);
    expect($res->ok)->toBeFalse()
        ->and($t->calls)->toBeEmpty()
        ->and($r->calls)->toBe(0);
})->with([
    'this-net' => 'http://0.0.0.1/', 'zero' => 'http://0.0.0.0/', 'rfc1918 10/8' => 'http://10.1.2.3/',
    'cgnat 100.64/10' => 'http://100.64.0.1/', 'cgnat top' => 'http://100.127.255.254/', 'loopback' => 'http://127.0.0.1/',
    'loopback high' => 'http://127.255.255.254/', 'metadata' => 'http://169.254.169.254/latest/meta-data/',
    'link-local' => 'http://169.254.0.1/', '172.16/12 low' => 'http://172.16.0.1/', '172.16/12 high' => 'http://172.31.255.255/',
    '192.0.0/24' => 'http://192.0.0.8/', 'test-net-1' => 'http://192.0.2.5/', '192.168/16' => 'http://192.168.1.1/',
    'bench 198.18' => 'http://198.18.0.1/', 'bench 198.19' => 'http://198.19.255.255/', 'test-net-2' => 'http://198.51.100.7/',
    'test-net-3' => 'http://203.0.113.9/', 'multicast' => 'http://224.0.0.1/', 'multicast top' => 'http://239.255.255.250/',
    'reserved 240' => 'http://240.0.0.1/', 'broadcast' => 'http://255.255.255.255/', 'trailing dot' => 'http://127.0.0.1./',
    'v6 unspecified' => 'http://[::]/', 'v6 loopback' => 'http://[::1]/', 'v4-mapped loopback' => 'http://[::ffff:127.0.0.1]/',
    'v4-mapped hex' => 'http://[::ffff:7f00:1]/', 'v4-mapped 10/8' => 'http://[::ffff:10.0.0.1]/',
    'v4-mapped metadata' => 'http://[::ffff:169.254.169.254]/', 'v4-mapped 192.168' => 'http://[0:0:0:0:0:ffff:c0a8:1]/',
    'nat64' => 'http://[64:ff9b::7f00:1]/', 'v4-compatible' => 'http://[::7f00:1]/', 'ula fc00' => 'http://[fc00::1]/',
    'ula fd' => 'http://[fd12:3456::1]/', 'v6 link-local' => 'http://[fe80::1]/', 'v6 multicast' => 'http://[ff02::1]/',
    'v6 doc' => 'http://[2001:db8::1]/', '6to4 loopback' => 'http://[2002:7f00:1::]/', 'teredo' => 'http://[2001:0:4136:e378::1]/',
]);

test('TC-MSG-091 decimal, hex, octal and short IPv4 literals are refused (never "normalised" into a pass)', function (string $url) {
    $f = sufFetcher($r, $t, script: [sufHtml()]);
    expect($f->fetchHtml($url)->ok)->toBeFalse()->and($t->calls)->toBeEmpty()->and($r->calls)->toBe(0);
})->with([
    'decimal loopback' => 'http://2130706433/', 'decimal metadata' => 'http://2852039166/', 'hex' => 'http://0x7f000001/',
    'hex dotted' => 'http://0x7f.0x0.0x0.0x1/', 'octal' => 'http://017700000001/', 'octal dotted' => 'http://0177.0.0.1/',
    'short 127.1' => 'http://127.1/', 'short 10.1' => 'http://10.1/', 'mixed' => 'http://0x7f.1/',
    'five parts' => 'http://1.2.3.4.5/', 'numeric tld' => 'http://example.123/', 'leading zero quad' => 'http://010.0.0.1/',
    'localhost' => 'http://localhost/', 'localhost sub' => 'http://foo.localhost/', 'single label' => 'http://intranet/',
    'internal tld' => 'http://db.internal/', 'local tld' => 'http://printer.local/', 'bad v6' => 'http://[::zz]/',
]);

test('TC-MSG-091 public literals are allowed (policy is not a blanket IP ban)', function () {
    $f = sufFetcher($r, $t, script: [sufHtml(), sufHtml()]);
    expect($f->fetchHtml('http://8.8.8.8/')->ok)->toBeTrue()
        ->and($f->fetchHtml('https://[2606:4700:4700::1111]/')->ok)->toBeTrue()
        ->and($r->calls)->toBe(0)
        ->and($t->calls[0]['ip'])->toBe('8.8.8.8');
});

test('TC-MSG-091 userinfo, non-80/443 ports and non-http schemes are refused', function (string $url) {
    $f = sufFetcher($r, $t, script: [sufHtml()]);
    expect($f->fetchHtml($url)->ok)->toBeFalse()->and($t->calls)->toBeEmpty();
})->with([
    'userinfo' => 'http://user:pw@example.com/', 'user only' => 'http://admin@example.com/', 'userinfo trick' => 'http://example.com@127.0.0.1/',
    'port 8080' => 'http://example.com:8080/', 'port 22' => 'http://example.com:22/', 'port 6379' => 'https://example.com:6379/',
    'port 8443' => 'https://example.com:8443/', 'ftp' => 'ftp://example.com/', 'file' => 'file:///etc/passwd',
    'gopher' => 'gopher://example.com/', 'javascript' => 'javascript:alert(1)', 'data' => 'data:text/html,hi',
    'backslash' => 'http://example.com\\@127.0.0.1/', 'space' => 'http://exa mple.com/', 'newline' => "http://example.com/\r\nHost: x",
]);

test('TC-MSG-091 ports 80 and 443 are the only ones allowed and are pinned to the right port', function () {
    $f = sufFetcher($r, $t, script: [sufHtml(), sufHtml(), sufHtml()]);
    expect($f->fetchHtml('http://example.com:80/a')->ok)->toBeTrue()
        ->and($f->fetchHtml('https://example.com:443/b')->ok)->toBeTrue()
        ->and($f->fetchHtml('https://example.com/c')->ok)->toBeTrue()
        ->and(array_column($t->calls, 'port'))->toBe([80, 443, 443])
        ->and($t->calls[0]['url'])->toBe('http://example.com/a');
});

test('TC-MSG-091 internal and ops-blocked hosts are refused', function () {
    $f = sufFetcher($r, $t, dns: ['chat.example.test' => ['93.184.216.34'], 'evil.example.net' => ['93.184.216.34'], 'a.evil.example.net' => ['93.184.216.34']],
        script: [sufHtml()], internal: ['https://chat.example.test'], blocked: ['evil.example.net']);
    foreach (['https://chat.example.test/support/abc', 'https://CHAT.example.test./join/tok', 'https://evil.example.net/', 'https://a.evil.example.net/'] as $u) {
        expect($f->fetchHtml($u)->ok)->toBeFalse();
    }
    expect($t->calls)->toBeEmpty()->and($r->calls)->toBe(0);
});

// ---------------------------------------------------------------- TC-MSG-092
test('TC-MSG-092 DNS answer with one public and one private address is refused (A public + AAAA private)', function () {
    $f = sufFetcher($r, $t, dns: ['mixed.example.com' => ['93.184.216.34', '::1']], script: [sufHtml()]);
    expect($f->fetchHtml('https://mixed.example.com/')->ok)->toBeFalse()->and($t->calls)->toBeEmpty();
});

test('TC-MSG-092 mixed answers in either order, v4-mapped answers and all-private answers are refused', function (array $answer) {
    $f = sufFetcher($r, $t, dns: ['h.example.com' => $answer], script: [sufHtml()]);
    expect($f->fetchHtml('https://h.example.com/')->ok)->toBeFalse()->and($t->calls)->toBeEmpty();
})->with([
    'private first' => [['10.0.0.5', '93.184.216.34']], 'metadata' => [['93.184.216.34', '169.254.169.254']],
    'mapped' => [['93.184.216.34', '::ffff:127.0.0.1']], 'all private' => [['192.168.0.9']], 'ula' => [['fd00::1']],
]);

test('TC-MSG-092 unresolvable host fails closed', function () {
    $f = sufFetcher($r, $t, dns: ['nx.example.com' => []], script: [sufHtml()]);
    $res = $f->fetchHtml('https://nx.example.com/');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('dns')->and($t->calls)->toBeEmpty();
});

test('TC-MSG-092 a fully public mixed v4/v6 answer is allowed and v4 is preferred for the pin', function () {
    $f = sufFetcher($r, $t, dns: ['dual.example.com' => ['2606:4700::1111', '93.184.216.34']], script: [sufHtml()]);
    expect($f->fetchHtml('https://dual.example.com/')->ok)->toBeTrue()->and($t->calls[0]['ip'])->toBe('93.184.216.34');
});

// ---------------------------------------------------------------- TC-MSG-093
test('TC-MSG-093 redirect to a private IP literal is blocked on hop 2 and never requested', function (string $target) {
    $f = sufFetcher($r, $t, script: [sufRedirect($target), sufHtml('<title>secret</title>')]);
    $res = $f->fetchHtml('https://example.com/start');
    expect($res->ok)->toBeFalse()->and($t->calls)->toHaveCount(1);
})->with(['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://2130706433/', 'http://10.0.0.1:80/', 'https://example.com:8443/', 'ftp://example.com/', '//127.0.0.1/x']);

test('TC-MSG-093 each hop is re-resolved and re-validated (hostname redirecting to a private DNS answer)', function () {
    $f = sufFetcher($r, $t, dns: ['intranet.example.com' => ['10.1.1.1']], script: [sufRedirect('https://intranet.example.com/'), sufHtml()]);
    $res = $f->fetchHtml('https://example.com/');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('blocked_ip')->and($t->calls)->toHaveCount(1)
        ->and($r->hosts)->toBe(['example.com', 'intranet.example.com']);
});

test('TC-MSG-093 redirect to an internal app host is blocked', function () {
    $f = sufFetcher($r, $t, dns: ['chat.example.test' => ['93.184.216.99']], script: [sufRedirect('https://chat.example.test/support/code'), sufHtml()], internal: ['chat.example.test']);
    expect($f->fetchHtml('https://example.com/')->ok)->toBeFalse()->and($t->calls)->toHaveCount(1);
});

test('TC-MSG-093 relative and absolute public redirects are followed; final URL reported', function () {
    $f = sufFetcher($r, $t, script: [sufRedirect('/a/b', 301), sufRedirect('c?x=1', 307), sufRedirect('https://cdn.example.org/final'), sufHtml('<title>ok</title>')]);
    $res = $f->fetchHtml('http://example.com/start');
    expect($res->ok)->toBeTrue()->and($res->finalUrl)->toBe('https://cdn.example.org/final')
        ->and(array_column($t->calls, 'url'))->toBe(['http://example.com/start', 'http://example.com/a/b', 'http://example.com/a/c?x=1', 'https://cdn.example.org/final']);
});

test('TC-MSG-093 redirect cap: 3 redirects are allowed, a 4th fails', function () {
    $ok = sufFetcher($r, $t, script: [sufRedirect('/1'), sufRedirect('/2'), sufRedirect('/3'), sufHtml()]);
    expect($ok->fetchHtml('https://example.com/')->ok)->toBeTrue()->and($t->calls)->toHaveCount(4);

    $bad = sufFetcher($r, $t, script: [sufRedirect('/1'), sufRedirect('/2'), sufRedirect('/3'), sufRedirect('/4'), sufHtml()]);
    $res = $bad->fetchHtml('https://example.com/');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('too_many_redirects')->and($t->calls)->toHaveCount(4);
});

test('TC-MSG-093 https to http downgrade is blocked, http to https is allowed; bad redirects fail', function () {
    $f = sufFetcher($r, $t, script: [sufRedirect('http://example.com/plain'), sufHtml()]);
    expect($f->fetchHtml('https://example.com/')->reason)->toBe('downgrade');

    $f = sufFetcher($r, $t, script: [sufRedirect('https://example.com/secure'), sufHtml()]);
    expect($f->fetchHtml('http://example.com/')->ok)->toBeTrue();

    $f = sufFetcher($r, $t, script: [new TransportResponse(302, []), sufHtml()]);
    expect($f->fetchHtml('https://example.com/')->ok)->toBeFalse();
});

// ---------------------------------------------------------------- TC-MSG-094
test('TC-MSG-094 DNS rebinding: the connection is pinned to the validated IP and DNS is not consulted again within the hop', function () {
    $resolver = new SufFakeResolver(['rebind.example.com' => [['93.184.216.34'], ['127.0.0.1']]], sequence: true);
    $transport = new SufFakeTransport([sufHtml()]);
    $f = new SafeUrlFetcher(new HostPolicy, $resolver, $transport);

    expect($f->fetchHtml('https://rebind.example.com/')->ok)->toBeTrue()
        ->and($resolver->calls)->toBe(1)
        ->and($transport->calls[0]['ip'])->toBe('93.184.216.34')
        ->and($transport->calls[0]['host'])->toBe('rebind.example.com');
});

test('TC-MSG-094 rebinding on a redirect back to the same host is caught: every hop resolves again and is re-validated', function () {
    $resolver = new SufFakeResolver(['rebind.example.com' => [['93.184.216.34'], ['127.0.0.1']]], sequence: true);
    $transport = new SufFakeTransport([sufRedirect('https://rebind.example.com/two'), sufHtml()]);
    $res = (new SafeUrlFetcher(new HostPolicy, $resolver, $transport))->fetchHtml('https://rebind.example.com/one');

    expect($res->ok)->toBeFalse()->and($transport->calls)->toHaveCount(1);
});

test('TC-MSG-094 CurlTransport pins with CURLOPT_RESOLVE and disables proxies, redirects, other protocols, cookies', function () {
    $o = CurlTransport::baseOptions('https://example.com/p', 'example.com', 443, '93.184.216.34', ['connectTimeout' => 3, 'timeout' => 5, 'accept' => 'text/html']);
    expect($o[CURLOPT_RESOLVE])->toBe(['example.com:443:93.184.216.34'])
        ->and($o[CURLOPT_URL])->toBe('https://example.com/p')
        ->and($o[CURLOPT_FOLLOWLOCATION])->toBeFalse()
        ->and($o[CURLOPT_PROXY])->toBe('')
        ->and($o[CURLOPT_NOPROXY])->toBe('*')
        ->and($o[CURLOPT_PROTOCOLS])->toBe(CURLPROTO_HTTP | CURLPROTO_HTTPS)
        ->and($o[CURLOPT_REDIR_PROTOCOLS])->toBe(CURLPROTO_HTTP | CURLPROTO_HTTPS)
        ->and($o[CURLOPT_USERAGENT])->toBe('BananaChatLinkPreview/1.0')
        ->and($o[CURLOPT_HTTPAUTH])->toBe(CURLAUTH_NONE)
        ->and($o[CURLOPT_SSL_VERIFYPEER])->toBeTrue()
        ->and($o[CURLOPT_HTTPHEADER])->toContain('Accept-Encoding: identity')
        ->and(CurlTransport::resolveEntry('example.com', 443, '2606:4700::1111'))->toBe('example.com:443:[2606:4700::1111]');
});

// ---------------------------------------------------------------- TC-MSG-095
test('TC-MSG-095 limits are handed to the transport: 512 KB html, 2 MB image, 5 s / 3 s timeouts, </head> stop, type allowlist', function () {
    $f = sufFetcher($r, $t, script: [sufHtml(), new TransportResponse(200, ['content-type' => 'image/png'], 'x')]);
    $f->fetchHtml('https://example.com/');
    $f->fetchImage('https://example.com/i.png');
    expect($t->calls[0]['opts'])->toMatchArray(['maxBytes' => 524288, 'stopAt' => '</head>', 'allowedTypes' => ['text/html', 'application/xhtml+xml'], 'timeout' => 5, 'connectTimeout' => 3])
        ->and($t->calls[1]['opts'])->toMatchArray(['maxBytes' => 2097152, 'allowedTypes' => ['image/jpeg', 'image/png', 'image/webp', 'image/gif']]);
});

test('TC-MSG-095 oversize HTML is cut to the cap (head only), oversize images are refused', function () {
    $big = str_repeat('a', 524288 + 5000);
    $f = sufFetcher($r, $t, script: [sufHtml($big), new TransportResponse(200, ['content-type' => 'image/png'], str_repeat('x', 100), truncated: true),
        new TransportResponse(200, ['content-type' => 'image/png'], str_repeat('x', 2097152 + 1)),
        new TransportResponse(200, ['content-type' => 'image/png', 'content-length' => '99999999'], 'x')]);
    $html = $f->fetchHtml('https://example.com/');
    expect($html->ok)->toBeTrue()->and(strlen($html->body))->toBe(524288);
    foreach (range(1, 3) as $_) {
        $res = $f->fetchImage('https://example.com/i.png');
        expect($res->ok)->toBeFalse()->and($res->reason)->toBe('too_large');
    }
});

test('TC-MSG-095 non-HTML, wrong-for-kind, compressed and non-200 responses are refused', function (TransportResponse $resp, string $kind) {
    $f = sufFetcher($r, $t, script: [$resp]);
    $res = $kind === 'html' ? $f->fetchHtml('https://example.com/') : $f->fetchImage('https://example.com/');
    expect($res->ok)->toBeFalse()->and($res->body)->toBe('');
})->with([
    'json' => [fn () => new TransportResponse(200, ['content-type' => 'application/json'], '{}'), 'html'],
    'plain' => [fn () => new TransportResponse(200, ['content-type' => 'text/plain'], 'x'), 'html'],
    'pdf' => [fn () => new TransportResponse(200, ['content-type' => 'application/pdf'], 'x'), 'html'],
    'svg as html' => [fn () => new TransportResponse(200, ['content-type' => 'image/svg+xml'], '<svg/>'), 'html'],
    'no type' => [fn () => new TransportResponse(200, [], '<html>'), 'html'],
    'gzip' => [fn () => new TransportResponse(200, ['content-type' => 'text/html', 'content-encoding' => 'gzip'], 'x'), 'html'],
    '404' => [fn () => new TransportResponse(404, ['content-type' => 'text/html'], 'nope'), 'html'],
    '500' => [fn () => new TransportResponse(500, ['content-type' => 'text/html'], 'boom'), 'html'],
    '204' => [fn () => new TransportResponse(204, [], ''), 'html'],
    'svg image' => [fn () => new TransportResponse(200, ['content-type' => 'image/svg+xml'], '<svg/>'), 'image'],
    'html as image' => [fn () => new TransportResponse(200, ['content-type' => 'text/html'], '<html>'), 'image'],
    'bmp' => [fn () => new TransportResponse(200, ['content-type' => 'image/bmp'], 'BM'), 'image'],
]);

test('TC-MSG-095 transport failure or exception yields a uniform failure with no message', function () {
    $f = sufFetcher($r, $t, script: [TransportResponse::failure(), new RuntimeException('cURL error 7: connect to 10.0.0.1:80 refused')]);
    $a = $f->fetchHtml('https://example.com/');
    $b = $f->fetchHtml('https://example.com/');
    expect($a->ok)->toBeFalse()->and($a->reason)->toBe('transport')->and($b->reason)->toBe('transport')
        ->and(json_encode([$a, $b]))->not->toContain('10.0.0.1');
});

test('TC-MSG-095 charset from Content-Type is surfaced for the parser', function () {
    $f = sufFetcher($r, $t, script: [new TransportResponse(200, ['content-type' => 'text/html; charset=TIS-620'], '<title>x</title>')]);
    expect($f->fetchHtml('https://example.com/')->charset)->toBe('TIS-620');
});

// ---------------------------------------------------------------- HostPolicy helpers
test('TC-MSG-090 token-looking URLs are recognised; ordinary slugs are not', function (string $path, ?string $query, bool $expected) {
    expect(HostPolicy::looksSensitive($path, $query))->toBe($expected);
})->with([
    '64 hex segment' => ['/meet/'.'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12', null, true],
    '32 hex' => ['/x/0123456789abcdef0123456789abcdef', null, true],
    'base64url token' => ['/reset/Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA', null, true],
    'token in query value' => ['/', 'x=Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA', true],
    'token= key' => ['/verify', 'token=abc', true],
    'access_token key' => ['/', 'access_token=1', true],
    'signature key' => ['/d', 'sig=abc&a=1', true],
    'ordinary' => ['/blog/2026/10/hello-world', 'page=2', false],
    'long hyphen slug' => ['/news/the-quick-brown-fox-jumps-over-the-lazy-dog-again-and-again', null, false],
    'short id' => ['/watch', 'v=dQw4w9WgXcQ', false],
    'empty value for token key' => ['/', 'token=', false],
    'root' => ['/', null, false],
]);

test('TC-MSG-093 reference resolution handles relative, dot-segment, scheme-relative and query-only refs', function () {
    $b = 'https://example.com/a/b/page?x=1';
    expect(HostPolicy::resolveReference($b, 'img.png'))->toBe('https://example.com/a/b/img.png')
        ->and(HostPolicy::resolveReference($b, '../img.png'))->toBe('https://example.com/a/img.png')
        ->and(HostPolicy::resolveReference($b, '/root.png'))->toBe('https://example.com/root.png')
        ->and(HostPolicy::resolveReference($b, '//cdn.example.org/i.png'))->toBe('https://cdn.example.org/i.png')
        ->and(HostPolicy::resolveReference($b, '?y=2'))->toBe('https://example.com/a/b/page?y=2')
        ->and(HostPolicy::resolveReference($b, 'http://other.test/x'))->toBe('http://other.test/x')
        ->and(HostPolicy::resolveReference($b, '/../../etc'))->toBe('https://example.com/etc')
        ->and(HostPolicy::resolveReference($b, ''))->toBeNull();
});

// ---------------------------------------------------------------- TC-MSG-096
test('TC-MSG-096 parser extracts og fields with twitter / title / meta fallbacks', function () {
    $p = new OgParser;
    $a = $p->parse('<html><head><title>Fallback</title><meta property="og:title" content="OG Title"><meta property="og:description" content="OG desc">'
        .'<meta property="og:site_name" content="Site"><meta property="og:image" content="/img/a.png"></head></html>', 'https://example.com/p/q');
    expect($a)->toBe(['title' => 'OG Title', 'description' => 'OG desc', 'site_name' => 'Site', 'image' => 'https://example.com/img/a.png']);

    $b = $p->parse('<head><title> Plain  Title </title><meta name="twitter:image" content="https://cdn.example.org/t.jpg"><meta name="description" content="d"></head>', 'https://www.example.com/x');
    expect($b)->toBe(['title' => 'Plain Title', 'description' => 'd', 'site_name' => 'www.example.com', 'image' => 'https://cdn.example.org/t.jpg']);

    $c = $p->parse('<meta name="twitter:title" content="TT"><meta name="twitter:description" content="TD">', 'https://e.com/');
    expect($c['title'])->toBe('TT')->and($c['description'])->toBe('TD')->and($c['image'])->toBeNull();
});

test('TC-MSG-096 HTML in metadata stays plain text; lengths are capped; non-http images dropped', function () {
    $p = new OgParser;
    $long = str_repeat('ก', 600);
    $r = $p->parse('<head><meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;Hello <b>bold</b>"><meta property="og:description" content="'.$long.'">'
        .'<meta property="og:site_name" content="'.str_repeat('s', 300).'"></head>', 'https://e.com/');
    expect($r['title'])->toBe('alert(1)Hello bold')
        ->and(mb_strlen($r['description']))->toBe(400)
        ->and(mb_strlen($r['site_name']))->toBe(100);

    foreach (['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x/y.png'] as $bad) {
        expect($p->parse('<meta property="og:title" content="t"><meta property="og:image" content="'.$bad.'">', 'https://e.com/')['image'])->toBeNull();
    }
    expect($p->parse('', 'https://e.com/')['title'])->toBeNull()
        ->and($p->parse('not html at all \0 <<<', 'https://e.com/')['title'])->toBeNull();
});

test('TC-MSG-096 XXE and entity-expansion payloads are harmless (no file read, no blow-up, no network)', function () {
    $secret = tempnam(sys_get_temp_dir(), 'xxe');
    file_put_contents($secret, 'TOP-SECRET-CONTENT');
    $xxe = '<!DOCTYPE html [<!ENTITY x SYSTEM "file://'.$secret.'">]><html><head><title>&x;</title><meta property="og:description" content="&x;"></head></html>';
    $lol = '<!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]>'
        .'<html><head><title>&f;&f;&f;&f;</title></head></html>';
    $remote = '<!DOCTYPE html [<!ENTITY y SYSTEM "http://127.0.0.1:9/evil">]><html><head><title>&y;</title></head></html>';
    $p = new OgParser;
    $t0 = microtime(true);
    foreach ([$xxe, $lol, $remote] as $html) {
        $r = $p->parse($html, 'https://e.com/');
        expect(json_encode($r))->not->toContain('TOP-SECRET-CONTENT')
            ->and(strlen((string) $r['title']))->toBeLessThanOrEqual(1000);
    }
    expect(microtime(true) - $t0)->toBeLessThan(3.0);
    @unlink($secret);
});

test('TC-MSG-096 non-UTF-8 pages are converted using the declared charset', function () {
    $latin = mb_convert_encoding('<head><title>café</title></head>', 'ISO-8859-1', 'UTF-8');
    expect((new OgParser)->parse($latin, 'https://e.com/', 'ISO-8859-1')['title'])->toBe('café');
    // a label mbstring rejects falls back to iconv
    $tis = iconv('UTF-8', 'TIS-620', '<head><title>สวัสดี</title></head>');
    expect((new OgParser)->parse($tis, 'https://e.com/', 'TIS-620')['title'])->toBe('สวัสดี');
});

// ---------------------------------------------------------------- TC-MSG-097
function sufImage(string $type = 'png', int $w = 20, int $h = 10): string
{
    $im = imagecreatetruecolor($w, $h);
    imagefill($im, 0, 0, imagecolorallocate($im, 200, 30, 30));
    ob_start();
    match ($type) {
        'png' => imagepng($im), 'jpeg' => imagejpeg($im), 'gif' => imagegif($im), 'webp' => imagewebp($im),
    };

    return (string) ob_get_clean();
}

test('TC-MSG-097 valid png/jpeg/gif/webp are re-encoded to webp on our disk, max 640 px wide', function (string $type) {
    Storage::fake(config('filesystems.default'));
    $key = (new ImageStore)->store(str_repeat('a', 64), sufImage($type, 1000, 500));
    expect($key)->toBe('link-previews/'.str_repeat('a', 64).'.webp');
    $bytes = Storage::disk(config('filesystems.default'))->get($key);
    expect(substr($bytes, 0, 4))->toBe('RIFF')->and(substr($bytes, 8, 4))->toBe('WEBP');
    [$w, $h] = getimagesizefromstring($bytes);
    expect($w)->toBe(640)->and($h)->toBe(320);
})->with(['png', 'jpeg', 'gif', 'webp']);

test('TC-MSG-097 small images are not upscaled', function () {
    Storage::fake(config('filesystems.default'));
    $key = (new ImageStore)->store(str_repeat('b', 64), sufImage('png', 40, 30));
    expect(getimagesizefromstring(Storage::disk(config('filesystems.default'))->get($key))[0])->toBe(40);
});

test('TC-MSG-097 svg, html, scripts, truncated, empty, oversize and pixel-bomb inputs are rejected and nothing is stored', function (string $bytes) {
    Storage::fake(config('filesystems.default'));
    expect((new ImageStore)->store(str_repeat('c', 64), $bytes))->toBeNull();
    Storage::disk(config('filesystems.default'))->assertDirectoryEmpty('link-previews');
})->with([
    'svg' => ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'],
    'svg bare' => ['<svg xmlns="http://www.w3.org/2000/svg"/>'],
    'html' => ['<html><script>alert(1)</script></html>'],
    'php' => ['<?php system($_GET["c"]);'],
    'empty' => [''],
    'garbage' => [random_bytes(64)],
    'bmp' => ['BM'.str_repeat("\0", 60)],
    'oversize' => [fn () => "\x89PNG\r\n\x1a\n".str_repeat('x', 2097152 + 1)],
    'pixel bomb' => [fn () => "\x89PNG\r\n\x1a\n".pack('N', 13).'IHDR'.pack('N', 20000).pack('N', 20000)."\x08\x02\x00\x00\x00".pack('N', 0)],
]);

test('TC-MSG-097 signedUrl points at our own disk', function () {
    Storage::fake(config('filesystems.default'));
    $s = new ImageStore;
    Storage::disk(config('filesystems.default'))->buildTemporaryUrlsUsing(fn ($path) => 'https://media.test/'.$path.'?sig=1');
    expect($s->signedUrl('link-previews/x.webp', now()->addHour()))->toStartWith('https://media.test/link-previews/');
});

// ---------------------------------------------------------------- review fixes
test('TC-MSG-094 percent-encoded and odd-charset hosts are refused (libcurl would decode them and miss the CURLOPT_RESOLVE pin)', function (string $url) {
    $f = sufFetcher($r, $t, dns: ['a.b.attacker.com' => ['93.184.216.34']], script: [sufHtml()]);
    expect($f->fetchHtml($url)->ok)->toBeFalse()->and($t->calls)->toBeEmpty()->and($r->calls)->toBe(0);
})->with([
    'encoded dot' => 'http://a%2eb.attacker.com/', 'encoded dot upper' => 'http://a%2Eb.attacker.com/', 'encoded loopback' => 'http://127%2e0%2e0%2e1/',
    'encoded letter' => 'http://%65xample.com/', 'encoded slash' => 'http://example.com%2f.evil.com/', 'v6 zone' => 'http://[fe80::1%25eth0]/',
    'bang' => 'http://ex!ample.com/', 'comma' => 'http://a,b.com/', 'star' => 'http://*.example.com/', 'pipe' => 'http://exa|mple.com/',
]);

test('TC-MSG-094 the same refusal applies to a redirect Location', function () {
    $f = sufFetcher($r, $t, script: [sufRedirect('http://a%2eb.example.com/x'), sufHtml()]);
    expect($f->fetchHtml('https://example.com/')->ok)->toBeFalse()->and($t->calls)->toHaveCount(1);
});

test('TC-MSG-094 CurlTransport refuses a host that is not the one the pin is keyed on (no network touched)', function (string $url, string $host) {
    $r = (new CurlTransport)->get($url, $host, 80, '93.184.216.34', ['maxBytes' => 10, 'stopAt' => null, 'allowedTypes' => [], 'timeout' => 1, 'connectTimeout' => 1, 'accept' => 'x']);
    expect($r->failed)->toBeTrue();
})->with([
    'mismatch' => ['http://evil.example.com/', 'good.example.com'],
    'percent host' => ['http://a%2eb.example.com/', 'a%2eb.example.com'],
    'decoded differs' => ['http://a%2eb.example.com/', 'a.b.example.com'],
    'userinfo' => ['http://u@example.com/', 'example.com'],
]);

test('TC-MSG-090 one-time-link check runs on every redirect hop, not just the first URL', function (string $target) {
    $f = sufFetcher($r, $t, script: [sufRedirect($target), sufHtml()]);
    $res = $f->fetchHtml('https://example.com/start');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('sensitive')->and($t->calls)->toHaveCount(1);
})->with([
    'token key' => 'https://cdn.example.org/magic?token=abc', 'hex path' => 'https://cdn.example.org/m/'.'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12',
    'relative' => '/reset/Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA',
]);

test('TC-MSG-090 the image fetch refuses a token-looking URL without sending a request', function () {
    $f = sufFetcher($r, $t, script: [new TransportResponse(200, ['content-type' => 'image/png'], 'x')]);
    $res = $f->fetchImage('https://cdn.example.org/i.png?sig=abc');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('sensitive')->and($t->calls)->toBeEmpty();
});

test('TC-MSG-085 our own edge: an address the internal hosts resolve to is refused for any hostname (hairpin)', function () {
    $f = sufFetcher($r, $t, dns: ['chat.example.test' => ['93.184.216.99', '2606:4700::6810'], 'alias.attacker.com' => ['93.184.216.99'], 'v6.attacker.com' => ['2606:4700::6810']],
        script: [sufHtml(), sufHtml()], internal: ['https://chat.example.test']);
    foreach (['https://alias.attacker.com/', 'https://v6.attacker.com/'] as $u) {
        $res = $f->fetchHtml($u);
        expect($res->ok)->toBeFalse()->and($res->reason)->toBe('own_ip');
    }
    expect($t->calls)->toBeEmpty();
    expect($f->fetchHtml('https://example.com/')->ok)->toBeTrue();
});

test('TC-MSG-085 configured egress IPs are denied even though they are public', function () {
    $resolver = new SufFakeResolver(['x.attacker.com' => ['203.0.114.5'], 'ok.example.com' => ['93.184.216.34']]);
    $transport = new SufFakeTransport([sufHtml(), sufHtml()]);
    $f = new SafeUrlFetcher(new HostPolicy([], [], ['203.0.114.5', '2606:4700::1']), $resolver, $transport);
    expect($f->fetchHtml('https://x.attacker.com/')->reason)->toBe('own_ip')
        ->and($f->fetchHtml('http://[2606:4700::1]/')->reason)->toBe('own_ip')
        ->and($f->fetchHtml('https://ok.example.com/')->ok)->toBeTrue();
});

test('TC-MSG-085 app.web_origins (config, array or comma list) marks aliases as internal', function () {
    config(['app.url' => 'https://chat.example.test', 'app.web_origins' => 'https://web.example.test, alias.example.test:8443']);
    $p = HostPolicy::fromApp();
    expect($p->isInternalHost('web.example.test'))->toBeTrue()->and($p->isInternalHost('alias.example.test'))->toBeTrue()
        ->and($p->isInternalHost('chat.example.test'))->toBeTrue()->and($p->isInternalHost('example.com'))->toBeFalse();
    config(['app.web_origins' => ['https://arr.example.test']]);
    expect(HostPolicy::fromApp()->isInternalHost('arr.example.test'))->toBeTrue();
});

test('TC-MSG-095 a slow DNS lookup cannot exceed the overall deadline: the hop is abandoned before any request', function () {
    $slow = new class implements DnsResolver
    {
        public function resolve(string $host): array
        {
            usleep(1300000);

            return ['93.184.216.34'];
        }
    };
    $t = new SufFakeTransport([sufHtml()]);
    $res = (new SafeUrlFetcher(new HostPolicy, $slow, $t, 1))->fetchHtml('https://example.com/');
    expect($res->ok)->toBeFalse()->and($res->reason)->toBe('timeout')->and($t->calls)->toBeEmpty();
});
