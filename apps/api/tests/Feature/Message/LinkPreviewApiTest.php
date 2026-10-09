<?php

use App\Jobs\FetchLinkPreview;
use App\Models\LinkPreview;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Storage;

/* FR-MSG-013 / DEC-100 / API-241 */

beforeEach(function () {
    Queue::fake();
    Cache::flush();
    config(['app.url' => 'https://chat.example.test']);
    app(SettingsService::class)->flush();
    $this->user = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'lp-test']);
    $this->ws->members()->attach($this->user->id, ['role' => 'owner']);
    [, $token] = loginAs($this->user);
    $this->h = wsHeaders($token, 'lp-test');
});

function lpGet($test, string $url, ?array $headers = null)
{
    return $test->getJson('/api/v1/link-preview?url='.rawurlencode($url), $headers ?? $test->h);
}

function lpRow(string $url, string $status, array $extra = []): LinkPreview
{
    return LinkPreview::create(['url_hash' => hash('sha256', $url), 'url' => $url, 'status' => $status] + $extra);
}

test('TC-MSG-087 unauthenticated and workspace-less requests are refused', function () {
    $this->getJson('/api/v1/link-preview?url='.rawurlencode('https://example.com/'))->assertUnauthorized();
    lpGet($this, 'https://example.com/', ['Authorization' => $this->h['Authorization']])->assertStatus(400);
    Queue::assertNothingPushed();
});

test('TC-MSG-084 invalid URLs are 422 LINK_PREVIEW_INVALID and never dispatch', function (?string $url) {
    $r = $url === null ? $this->getJson('/api/v1/link-preview', $this->h) : lpGet($this, $url);
    $r->assertStatus(422)->assertJsonPath('error.code', 'LINK_PREVIEW_INVALID');
    expect(LinkPreview::count())->toBe(0);
    Queue::assertNothingPushed();
})->with([
    'missing' => [null], 'empty' => [''], 'not a url' => ['hello world'], 'relative' => ['/board/x'], 'ftp' => ['ftp://example.com/x'],
    'javascript' => ['javascript:alert(1)'], 'file' => ['file:///etc/passwd'], 'userinfo' => ['https://u:p@example.com/'],
    'userinfo trick' => ['https://example.com@evil.test/'], 'port 8080' => ['http://example.com:8080/'], 'port 22' => ['https://example.com:22/'],
    'too long' => ['https://example.com/'.str_repeat('a', 2100)], 'loopback' => ['http://127.0.0.1/'], 'metadata' => ['http://169.254.169.254/'],
    'private' => ['http://192.168.0.1/'], 'decimal ip' => ['http://2130706433/'], 'hex ip' => ['http://0x7f000001/'], 'v6 loopback' => ['http://[::1]/'],
    'mapped v6' => ['http://[::ffff:127.0.0.1]/'], 'localhost' => ['http://localhost/'], 'internal tld' => ['http://db.internal/'],
]);

test('TC-MSG-084 array url parameter is refused', function () {
    $this->getJson('/api/v1/link-preview?url[]=https://example.com', $this->h)->assertStatus(422)->assertJsonPath('error.code', 'LINK_PREVIEW_INVALID');
});

test('TC-MSG-085 this app\'s own hosts (APP_URL) are refused: /support, /join, /board, /meet', function (string $url) {
    lpGet($this, $url)->assertStatus(422)->assertJsonPath('error.code', 'LINK_PREVIEW_INVALID')->assertJsonPath('error.details.reason', 'internal');
    expect(LinkPreview::count())->toBe(0);
    Queue::assertNothingPushed();
})->with([
    'support' => ['https://chat.example.test/support/abcdef'], 'join' => ['https://chat.example.test/join/sometoken'],
    'ticket' => ['https://chat.example.test/board/01J9ZZZZZZZZZZZZZZZZZZZZZZ?ws=acme'], 'meeting' => ['https://chat.example.test/meet/'.str_repeat('a', 64)],
    'root' => ['https://chat.example.test/'], 'uppercase host' => ['https://CHAT.Example.Test/x'], 'trailing dot' => ['https://chat.example.test./x'],
    'with port' => ['https://chat.example.test:443/x'],
]);

test('TC-MSG-085 the request host is internal even when APP_URL differs', function () {
    $this->getJson('http://edge.example.test/api/v1/link-preview?url='.rawurlencode('https://edge.example.test/support/x'), $this->h)
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'internal');
    Queue::assertNothingPushed();
});

test('TC-MSG-086 cache miss returns pending 202 and dispatches exactly one job on the previews queue', function () {
    $r = lpGet($this, 'https://example.com/article');
    $r->assertStatus(202)->assertJsonPath('data.status', 'pending')->assertJsonPath('data.url', 'https://example.com/article');
    expect($r->headers->get('Cache-Control'))->toContain('no-store');

    $row = LinkPreview::firstOrFail();
    expect($row->status)->toBe('pending')->and($row->url_hash)->toBe(hash('sha256', 'https://example.com/article'))
        ->and($row->expires_at->isFuture())->toBeTrue();
    Queue::assertPushedOn('previews', FetchLinkPreview::class, fn ($j) => $j->previewId === $row->id);

    // polling while pending: still 202, still one job, one row
    lpGet($this, 'https://example.com/article')->assertStatus(202);
    lpGet($this, 'https://example.com/article')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 1);
    expect(LinkPreview::count())->toBe(1);
});

test('TC-MSG-086 URL variants normalise to ONE cache row and ONE job', function () {
    foreach (['https://EXAMPLE.com/a?x=1#frag', 'https://example.com:443/a?x=1', 'HTTPS://example.com/a?x=1'] as $u) {
        lpGet($this, $u)->assertStatus(202);
    }
    Queue::assertPushed(FetchLinkPreview::class, 1);
    expect(LinkPreview::count())->toBe(1)->and(LinkPreview::first()->url)->toBe('https://example.com/a?x=1');
});

test('TC-MSG-086 lock held by another request: pending, no second job, no row', function () {
    $hash = hash('sha256', 'https://example.com/locked');
    $lock = Cache::lock('lp:'.$hash, 30);
    expect($lock->get())->toBeTrue();
    lpGet($this, 'https://example.com/locked')->assertStatus(202)->assertJsonPath('data.status', 'pending');
    Queue::assertNothingPushed();
    expect(LinkPreview::count())->toBe(0);
    $lock->release();
    lpGet($this, 'https://example.com/locked')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 1);
});

test('TC-MSG-086 fresh ready row is served from cache with a signed URL to OUR copy, never the third-party image', function () {
    Storage::fake(config('filesystems.default'));
    Storage::disk(config('filesystems.default'))->buildTemporaryUrlsUsing(fn ($p) => 'https://media.example.test/'.$p.'?sig=abc');
    lpRow('https://example.com/p', 'ready', ['title' => 'T', 'description' => 'D', 'site_name' => 'S', 'image_key' => 'link-previews/x.webp',
        'fetched_at' => now(), 'expires_at' => now()->addHours(3)]);

    $r = lpGet($this, 'https://example.com/p')->assertOk()
        ->assertJsonPath('data.status', 'ready')->assertJsonPath('data.title', 'T')->assertJsonPath('data.description', 'D')->assertJsonPath('data.site_name', 'S');
    expect($r->json('data.image_url'))->toStartWith('https://media.example.test/link-previews/x.webp')
        ->and($r->json('data.image_expires_at'))->not->toBeNull()
        ->and(array_keys($r->json('data')))->toEqualCanonicalizing(['status', 'url', 'title', 'description', 'site_name', 'image_url', 'image_expires_at', 'fetched_at']);
    Queue::assertNothingPushed();
});

test('TC-MSG-086 ready row without an image has null image fields', function () {
    lpRow('https://example.com/p', 'ready', ['title' => 'T', 'fetched_at' => now(), 'expires_at' => now()->addHour()]);
    lpGet($this, 'https://example.com/p')->assertOk()->assertJsonPath('data.image_url', null)->assertJsonPath('data.image_expires_at', null);
});

test('TC-MSG-086 negative cache: fresh none is served as none without a new fetch; stale none and stale ready refetch', function () {
    lpRow('https://example.com/n', 'none', ['expires_at' => now()->addMinutes(30)]);
    lpGet($this, 'https://example.com/n')->assertOk()->assertExactJson(['data' => ['status' => 'none', 'url' => 'https://example.com/n']]);
    Queue::assertNothingPushed();

    LinkPreview::where('url', 'https://example.com/n')->update(['expires_at' => now()->subMinute()]);
    lpGet($this, 'https://example.com/n')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 1);

});

test('TC-MSG-086 refresh never downgrades a good card: stale ready keeps serving the old data while ONE refresh job runs', function () {
    $row = lpRow('https://example.com/r', 'ready', ['title' => 'Old', 'image_key' => 'link-previews/r.webp', 'expires_at' => now()->subMinute()]);
    lpGet($this, 'https://example.com/r')->assertOk()->assertJsonPath('data.status', 'ready')->assertJsonPath('data.title', 'Old');
    lpGet($this, 'https://example.com/r')->assertOk()->assertJsonPath('data.title', 'Old');
    Queue::assertPushed(FetchLinkPreview::class, 1);
    Queue::assertPushed(FetchLinkPreview::class, fn ($j) => $j->previewId === $row->id && $j->refresh === true);
    $row->refresh();
    expect($row->status)->toBe('ready')->and($row->title)->toBe('Old')->and($row->image_key)->toBe('link-previews/r.webp')->and($row->expires_at->isFuture())->toBeTrue();
});

test('TC-MSG-098 stale pending (worker died) is retried after its 60 s TTL, fresh pending is not', function () {
    $row = lpRow('https://example.com/stuck', 'pending', ['expires_at' => now()->addSeconds(30)]);
    lpGet($this, 'https://example.com/stuck')->assertStatus(202);
    Queue::assertNothingPushed();

    $row->update(['expires_at' => now()->subSecond()]);
    lpGet($this, 'https://example.com/stuck')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 1);
    expect($row->fresh()->expires_at->isFuture())->toBeTrue();
});

test('TC-MSG-089 kill switch: link_preview.enabled=false answers none, fetches nothing, stores nothing', function () {
    app(SettingsService::class)->set('link_preview.enabled', false);
    lpGet($this, 'https://example.com/x')->assertOk()->assertJsonPath('data.status', 'none');
    Queue::assertNothingPushed();
    expect(LinkPreview::count())->toBe(0);

    // even a cached ready row is not served while disabled? (kill switch wins before the cache)
    lpRow('https://example.com/cached', 'ready', ['title' => 'T', 'expires_at' => now()->addHour()]);
    lpGet($this, 'https://example.com/cached')->assertOk()->assertJsonPath('data.status', 'none');

    // internal URLs are still refused (validation precedes the switch)
    lpGet($this, 'https://chat.example.test/support/x')->assertStatus(422);
});

test('TC-MSG-089 ops blocked_hosts answers none for the host and its subdomains', function () {
    app(SettingsService::class)->set('link_preview.blocked_hosts', ['blocked.example.net']);
    foreach (['https://blocked.example.net/a', 'https://sub.blocked.example.net/a'] as $u) {
        lpGet($this, $u)->assertOk()->assertJsonPath('data.status', 'none');
    }
    lpGet($this, 'https://notblocked.example.net/a')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 1);
});

test('TC-MSG-090 token-looking URLs are skipped: none, no row, no job', function (string $url) {
    lpGet($this, $url)->assertOk()->assertJsonPath('data.status', 'none');
    Queue::assertNothingPushed();
    expect(LinkPreview::count())->toBe(0);
})->with([
    'hex64' => ['https://example.com/m/'.str_repeat('ab', 32)], 'b64url' => ['https://example.com/reset/Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA'],
    'token key' => ['https://example.com/verify?token=abc'], 'query token' => ['https://example.com/?x=Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbA'],
]);

test('TC-MSG-090 ordinary article URLs are not mistaken for tokens', function () {
    lpGet($this, 'https://example.com/news/the-quick-brown-fox-jumps-over-the-lazy-dog-again?page=2')->assertStatus(202);
});

test('TC-MSG-088 per-user throttle: 61st call in a minute is 429 RATE_LIMITED', function () {
    lpRow('https://example.com/hot', 'none', ['expires_at' => now()->addHour()]);
    foreach (range(1, 60) as $_) {
        lpGet($this, 'https://example.com/hot')->assertOk();
    }
    lpGet($this, 'https://example.com/hot')->assertStatus(429)->assertJsonPath('error.code', 'RATE_LIMITED');
});

test('TC-MSG-088 uncached-fetch budget: 20 distinct misses per user per minute, cached answers do not count', function () {
    foreach (range(1, 20) as $i) {
        lpGet($this, "https://example.com/p{$i}")->assertStatus(202);
    }
    Queue::assertPushed(FetchLinkPreview::class, 20);
    $r = lpGet($this, 'https://example.com/p21')->assertStatus(429)->assertJsonPath('error.code', 'RATE_LIMITED');
    expect($r->headers->get('Retry-After'))->not->toBeNull();
    Queue::assertPushed(FetchLinkPreview::class, 20);
    expect(LinkPreview::where('url', 'https://example.com/p21')->exists())->toBeFalse();

    // pending/ready answers for already-known URLs still work
    lpGet($this, 'https://example.com/p1')->assertStatus(202);
});

test('TC-MSG-088 workspace-wide fetch budget (300/min) stops a fleet of users', function () {
    RateLimiter::increment('lp-fetch:w:'.$this->ws->id, 60, 299);
    lpGet($this, 'https://example.com/w1')->assertStatus(202);
    lpGet($this, 'https://example.com/w2')->assertStatus(429);
});

test('TC-MSG-088 no upstream detail ever appears in a non-validation response', function () {
    lpRow('https://example.com/f', 'none', ['final_host' => 'internal.corp', 'expires_at' => now()->addHour(), 'title' => 'leak?']);
    $body = lpGet($this, 'https://example.com/f')->assertOk()->getContent();
    expect($body)->not->toContain('internal.corp')->not->toContain('leak?');
});

test('TC-MSG-088 per-target-host fetch limiter (30 uncached/min across users): the 31st is 429 and spares other hosts', function () {
    RateLimiter::increment('lp-fetch:h:busy.example.com', 60, 29);
    lpGet($this, 'https://busy.example.com/a')->assertStatus(202);
    lpGet($this, 'https://busy.example.com/b')->assertStatus(429)->assertJsonPath('error.code', 'RATE_LIMITED');
    lpGet($this, 'https://other.example.com/a')->assertStatus(202);
    Queue::assertPushed(FetchLinkPreview::class, 2);
    expect(LinkPreview::where('url', 'https://busy.example.com/b')->exists())->toBeFalse();
});
