<?php

use App\Domain\LinkPreview\DnsResolver;
use App\Domain\LinkPreview\FetchResult;
use App\Domain\LinkPreview\HostPolicy;
use App\Domain\LinkPreview\HttpTransport;
use App\Domain\LinkPreview\SafeUrlFetcher;
use App\Domain\LinkPreview\TransportResponse;
use App\Jobs\FetchLinkPreview;
use App\Models\LinkPreview;
use App\Services\SettingsService;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;

/* TC-MSG-098 — FetchLinkPreview: success / none / recovery / image failure. FR-MSG-013, DEC-100. */

beforeEach(function () {
    Cache::flush();
    config(['app.url' => 'https://chat.example.test']);
    app(SettingsService::class)->flush();
    Storage::fake(config('filesystems.default'));
});

function fljRow(string $url = 'https://example.com/post', string $status = 'pending'): LinkPreview
{
    return LinkPreview::create(['url_hash' => hash('sha256', $url), 'url' => $url, 'status' => $status, 'expires_at' => now()->addMinute()]);
}

function fljPng(): string
{
    $im = imagecreatetruecolor(800, 400);
    ob_start();
    imagepng($im);

    return (string) ob_get_clean();
}

function fljRun(LinkPreview $row, ?SafeUrlFetcher $fetcher = null): void
{
    if ($fetcher) {
        app()->instance(SafeUrlFetcher::class, $fetcher);
    }
    app()->call([new FetchLinkPreview($row->id), 'handle']);
}

function fljFetcher(array $html, ?array $image = null): SafeUrlFetcher
{
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->andReturnUsing(fn () => $html['result']);
    if ($image !== null) {
        $m->shouldReceive('fetchImage')->andReturnUsing(fn () => $image['result']);
    } else {
        $m->shouldReceive('fetchImage')->never();
    }

    return $m;
}

const FLJ_HTML = '<html><head><title>Page</title><meta property="og:title" content="Great Post"><meta property="og:description" content="About things">'
    .'<meta property="og:site_name" content="Example"><meta property="og:image" content="/cover.png"></head><body></body></html>';

test('TC-MSG-098 success stores a ready row with parsed fields and our re-encoded image', function () {
    $row = fljRow();
    fljRun($row, fljFetcher(
        ['result' => FetchResult::success('https://www.example.com/post', FLJ_HTML, 'text/html', 'utf-8')],
        ['result' => FetchResult::success('https://www.example.com/cover.png', fljPng(), 'image/png', null)],
    ));
    $row->refresh();
    expect($row->status)->toBe('ready')->and($row->title)->toBe('Great Post')->and($row->description)->toBe('About things')
        ->and($row->site_name)->toBe('Example')->and($row->final_host)->toBe('www.example.com')
        ->and($row->fetched_at)->not->toBeNull()
        ->and($row->expires_at->between(now()->addHours(23), now()->addHours(25)))->toBeTrue()
        ->and($row->image_key)->toBe('link-previews/'.$row->url_hash.'.webp');
    $img = Storage::disk(config('filesystems.default'))->get($row->image_key);
    expect(substr($img, 8, 4))->toBe('WEBP')->and(getimagesizefromstring($img)[0])->toBe(640);
});

test('TC-MSG-098 the image is resolved against the FINAL url and fetched through the same guarded fetcher', function () {
    $row = fljRow();
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->once()->with('https://example.com/post')->andReturn(FetchResult::success('https://www.example.com/a/post', FLJ_HTML, 'text/html', null));
    $m->shouldReceive('fetchImage')->once()->with('https://www.example.com/cover.png')->andReturn(FetchResult::fail('dns'));
    fljRun($row, $m);
    expect($row->fresh()->status)->toBe('ready');
});

test('TC-MSG-098 image failure of every kind still yields a ready card without an image', function (FetchResult|Closure $imageResult) {
    $row = fljRow();
    $result = $imageResult instanceof Closure ? $imageResult() : $imageResult;
    fljRun($row, fljFetcher(['result' => FetchResult::success('https://example.com/post', FLJ_HTML, 'text/html', null)], ['result' => $result]));
    $row->refresh();
    expect($row->status)->toBe('ready')->and($row->title)->toBe('Great Post')->and($row->image_key)->toBeNull();
    Storage::disk(config('filesystems.default'))->assertDirectoryEmpty('link-previews');
})->with([
    'fetch failed' => [fn () => FetchResult::fail('blocked_ip')],
    'svg bytes' => [fn () => FetchResult::success('https://example.com/c.png', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/png', null)],
    'not an image' => [fn () => FetchResult::success('https://example.com/c.png', '<html>', 'image/png', null)],
]);

test('TC-MSG-098 every upstream failure stores none, uniformly, with no upstream detail', function (string $reason) {
    $row = fljRow();
    fljRun($row, fljFetcher(['result' => FetchResult::fail($reason)]));
    $row->refresh();
    expect($row->status)->toBe('none')->and($row->title)->toBeNull()->and($row->description)->toBeNull()->and($row->image_key)->toBeNull()
        ->and($row->final_host)->toBeNull()
        ->and($row->expires_at->between(now()->addMinutes(59), now()->addMinutes(61)))->toBeTrue()
        ->and(json_encode(array_values($row->toArray())))->not->toContain('"'.$reason.'"');
})->with(['blocked_ip', 'dns', 'timeout', 'status', 'content_type', 'too_large', 'transport', 'too_many_redirects', 'downgrade', 'internal_host']);

test('TC-MSG-098 a page without any title is none; an unexpected exception is none', function () {
    $row = fljRow();
    fljRun($row, fljFetcher(['result' => FetchResult::success('https://example.com/post', '<html><body>nothing</body></html>', 'text/html', null)]));
    expect($row->fresh()->status)->toBe('none');

    $row2 = fljRow('https://example.com/boom');
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->andThrow(new RuntimeException('cURL error 7: 10.0.0.1 refused'));
    fljRun($row2, $m);
    expect($row2->fresh()->status)->toBe('none');
});

test('TC-MSG-098 kill switch flipped after dispatch: nothing is fetched', function () {
    app(SettingsService::class)->set('link_preview.enabled', false);
    $row = fljRow();
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->never();
    fljRun($row, $m);
    expect($row->fresh()->status)->toBe('none');
});

test('TC-MSG-085 defence in depth: an internal or token URL that somehow got a row is never fetched', function (string $url) {
    $row = fljRow($url);
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->never();
    fljRun($row, $m);
    expect($row->fresh()->status)->toBe('none');
})->with([
    'support' => ['https://chat.example.test/support/abc'], 'private ip' => ['http://127.0.0.1/'], 'port' => ['http://example.com:8080/'],
    'token' => ['https://example.com/m/'.str_repeat('ab', 32)],
]);

test('TC-MSG-098 only pending rows are processed (ready/none/missing rows are left alone)', function () {
    $ready = LinkPreview::create(['url_hash' => hash('sha256', 'u1'), 'url' => 'https://example.com/u1', 'status' => 'ready', 'title' => 'Keep']);
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->never();
    app()->instance(SafeUrlFetcher::class, $m);
    app()->call([new FetchLinkPreview($ready->id), 'handle']);
    app()->call([new FetchLinkPreview('01J9ZZZZZZZZZZZZZZZZZZZZZZ'), 'handle']);
    expect($ready->fresh()->title)->toBe('Keep');
});

test('TC-MSG-098 failed() (timeout / worker crash) resolves a pending row to none instead of leaving it stuck', function () {
    $row = fljRow();
    (new FetchLinkPreview($row->id))->failed(new RuntimeException('timeout'));
    expect($row->fresh()->status)->toBe('none');

    $ready = LinkPreview::create(['url_hash' => hash('sha256', 'u2'), 'url' => 'https://example.com/u2', 'status' => 'ready', 'title' => 'Keep']);
    (new FetchLinkPreview($ready->id))->failed(null);
    expect($ready->fresh()->status)->toBe('ready');
});

test('TC-MSG-098 job is routed to the dedicated previews queue and is single-attempt', function () {
    $job = new FetchLinkPreview('x');
    expect($job->queue)->toBe('previews')->and($job->tries)->toBe(1)->and($job->timeout)->toBe(30);
});

test('TC-MSG-098 redirect to a private host is none end-to-end through the REAL SafeUrlFetcher with fakes', function () {
    $row = fljRow();
    $resolver = new class implements DnsResolver
    {
        public function resolve(string $host): array
        {
            return $host === 'example.com' ? ['93.184.216.34'] : ['10.0.0.9'];
        }
    };
    $transport = new class implements HttpTransport
    {
        public int $calls = 0;

        public function get(string $url, string $host, int $port, string $ip, array $opts): TransportResponse
        {
            $this->calls++;

            return new TransportResponse(302, ['location' => 'https://intranet.example.com/secret']);
        }
    };
    fljRun($row, new SafeUrlFetcher(new HostPolicy, $resolver, $transport));
    expect($row->fresh()->status)->toBe('none')->and($transport->calls)->toBe(1);
});

test('TC-MSG-098 prune command removes rows and images older than 7 days and keeps newer ones', function () {
    $disk = Storage::disk(config('filesystems.default'));
    $old = LinkPreview::create(['url_hash' => hash('sha256', 'old'), 'url' => 'https://example.com/old', 'status' => 'ready', 'image_key' => 'link-previews/old.webp']);
    $new = LinkPreview::create(['url_hash' => hash('sha256', 'new'), 'url' => 'https://example.com/new', 'status' => 'ready', 'image_key' => 'link-previews/new.webp']);
    $disk->put('link-previews/old.webp', 'x');
    $disk->put('link-previews/new.webp', 'x');
    LinkPreview::query()->whereKey($old->id)->toBase()->update(['updated_at' => now()->subDays(8)]);

    Artisan::call('link-previews:prune');

    expect(LinkPreview::find($old->id))->toBeNull()->and(LinkPreview::find($new->id))->not->toBeNull();
    $disk->assertMissing('link-previews/old.webp');
    $disk->assertExists('link-previews/new.webp');
});

test('TC-MSG-098 the prune command is scheduled daily', function () {
    $events = collect(app(Schedule::class)->events())->filter(fn ($e) => str_contains($e->command ?? '', 'link-previews:prune'));
    expect($events)->toHaveCount(1)->and($events->first()->expression)->toBe('30 3 * * *');
});

function fljReady(string $url = 'https://example.com/post', ?string $image = 'link-previews/old.webp'): LinkPreview
{
    return LinkPreview::create(['url_hash' => hash('sha256', $url), 'url' => $url, 'status' => 'ready', 'title' => 'Old', 'description' => 'Old d',
        'image_key' => $image, 'fetched_at' => now()->subDay(), 'expires_at' => now()->addMinute()]);
}

test('TC-MSG-098 a failed REFRESH keeps the old ready card and image, and backs off', function () {
    $disk = Storage::disk(config('filesystems.default'));
    $row = fljReady();
    $disk->put('link-previews/old.webp', 'x');
    app()->instance(SafeUrlFetcher::class, fljFetcher(['result' => FetchResult::fail('dns')]));
    app()->call([new FetchLinkPreview($row->id, true), 'handle']);
    $row->refresh();
    expect($row->status)->toBe('ready')->and($row->title)->toBe('Old')->and($row->image_key)->toBe('link-previews/old.webp')
        ->and($row->expires_at->between(now()->addMinutes(59), now()->addMinutes(61)))->toBeTrue();
    $disk->assertExists('link-previews/old.webp');
});

test('TC-MSG-098 a refresh crash (failed()) also keeps the old card', function () {
    $row = fljReady();
    (new FetchLinkPreview($row->id, true))->failed(new RuntimeException('x'));
    expect($row->fresh()->status)->toBe('ready')->and($row->fresh()->title)->toBe('Old');
});

test('TC-MSG-098 a successful refresh replaces the data; the old WebP is deleted if the new card has no image', function () {
    $disk = Storage::disk(config('filesystems.default'));
    $row = fljReady();
    $disk->put('link-previews/old.webp', 'x');
    $html = '<head><meta property="og:title" content="New"></head>';
    app()->instance(SafeUrlFetcher::class, fljFetcher(['result' => FetchResult::success('https://example.com/post', $html, 'text/html', null)]));
    app()->call([new FetchLinkPreview($row->id, true), 'handle']);
    $row->refresh();
    expect($row->title)->toBe('New')->and($row->description)->toBeNull()->and($row->image_key)->toBeNull();
    $disk->assertMissing('link-previews/old.webp');
});

test('TC-MSG-098 first-ever failure becomes none and any stored WebP is deleted', function () {
    $disk = Storage::disk(config('filesystems.default'));
    $row = fljRow();
    $row->update(['image_key' => 'link-previews/orphan.webp']);
    $disk->put('link-previews/orphan.webp', 'x');
    fljRun($row, fljFetcher(['result' => FetchResult::fail('status')]));
    expect($row->fresh()->status)->toBe('none')->and($row->fresh()->image_key)->toBeNull();
    $disk->assertMissing('link-previews/orphan.webp');
});

test('TC-MSG-098 a non-refresh job leaves a ready row alone (refresh is opt-in)', function () {
    $row = fljReady();
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->never();
    app()->instance(SafeUrlFetcher::class, $m);
    app()->call([new FetchLinkPreview($row->id), 'handle']);
    expect($row->fresh()->title)->toBe('Old');
});

test('TC-MSG-090 a token-looking og:image URL is never requested; the card is ready without an image', function () {
    $row = fljRow();
    $html = '<head><meta property="og:title" content="T"><meta property="og:image" content="https://cdn.example.org/i.png?token=abc"></head>';
    $m = Mockery::mock(SafeUrlFetcher::class);
    $m->shouldReceive('fetchHtml')->andReturn(FetchResult::success('https://example.com/post', $html, 'text/html', null));
    $m->shouldReceive('fetchImage')->never();
    fljRun($row, $m);
    expect($row->fresh()->status)->toBe('ready')->and($row->fresh()->image_key)->toBeNull();
});
