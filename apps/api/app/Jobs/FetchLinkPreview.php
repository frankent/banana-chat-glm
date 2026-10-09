<?php

namespace App\Jobs;

use App\Domain\LinkPreview\HostPolicy;
use App\Domain\LinkPreview\ImageStore;
use App\Domain\LinkPreview\OgParser;
use App\Domain\LinkPreview\SafeUrlFetcher;
use App\Models\LinkPreview;
use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Log;

/**
 * FR-MSG-013 / DEC-100 / API-241 — fetch one external page on the dedicated
 * `previews` queue (own worker, own egress policy). EVERY failure collapses to
 * status `none`; nothing about the upstream is stored or logged beyond a short
 * reason code.
 */
class FetchLinkPreview implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;

    public int $tries = 1;

    public int $timeout = 30;

    /** @param bool $refresh true = re-fetch a stale READY row without ever downgrading it */
    public function __construct(public readonly string $previewId, public readonly bool $refresh = false)
    {
        $this->onQueue('previews');
    }

    public function handle(SafeUrlFetcher $fetcher, OgParser $parser, ImageStore $images, SettingsService $settings): void
    {
        $row = LinkPreview::query()->find($this->previewId);
        if ($row === null || ! $this->eligible($row)) {
            return;
        }
        $refreshing = $row->status === LinkPreview::READY;
        $started = microtime(true);

        try {
            $reason = $this->run($row, $fetcher, $parser, $images, $settings);
        } catch (\Throwable) {
            $reason = 'exception';
        }

        if ($reason !== 'ok') {
            $refreshing ? $this->backOff($row) : $this->markNone($row);
        }
        Log::info('link_preview.fetched', [
            'url_hash' => $row->url_hash,
            'status' => $row->status,
            'reason' => $reason,
            'ms' => (int) ((microtime(true) - $started) * 1000),
        ]);
    }

    public function failed(?\Throwable $e): void
    {
        $row = LinkPreview::query()->find($this->previewId);
        if ($row === null || ! $this->eligible($row)) {
            return;
        }
        $row->status === LinkPreview::READY ? $this->backOff($row) : $this->markNone($row);
    }

    /** A pending row, or (refresh only) a ready one. Anything else is somebody else's work. */
    private function eligible(LinkPreview $row): bool
    {
        return $row->status === LinkPreview::PENDING || ($this->refresh && $row->status === LinkPreview::READY);
    }

    private function run(LinkPreview $row, SafeUrlFetcher $fetcher, OgParser $parser, ImageStore $images, SettingsService $settings): string
    {
        if (! $settings->bool('link_preview.enabled')) {
            return 'disabled';
        }
        $hosts = HostPolicy::fromApp();
        $parts = $hosts->parse($row->url);
        if (! $parts['ok'] || $hosts->isInternalHost($parts['host'])) {
            return 'invalid';
        }
        if (HostPolicy::looksSensitive($parts['path'], $parts['query'])) {
            return 'sensitive';
        }

        $page = $fetcher->fetchHtml($row->url);
        if (! $page->ok) {
            return $page->reason;
        }
        $meta = $parser->parse($page->body, $page->finalUrl, $page->charset);
        if ($meta['title'] === null) {
            return 'no_title'; // a card without a title adds nothing over the plain link
        }

        // Image failure never downgrades the card to `none`.
        $imageKey = null;
        if ($meta['image'] !== null) {
            // R18 also applies to the image URL: never request a token-looking one.
            $ip = $hosts->parse($meta['image']);
            if ($ip['ok'] && ! HostPolicy::looksSensitive($ip['path'], $ip['query'])) {
                $img = $fetcher->fetchImage($meta['image']);
                if ($img->ok) {
                    $imageKey = $images->store($row->url_hash, $img->body);
                }
            }
        }
        $this->dropImage($row->image_key, $imageKey); // superseded WebP (same key = overwritten in place)

        $row->forceFill([
            'status' => LinkPreview::READY,
            'final_host' => mb_substr((string) parse_url($page->finalUrl, PHP_URL_HOST), 0, 255) ?: null,
            'title' => $meta['title'],
            'description' => $meta['description'],
            'site_name' => $meta['site_name'],
            'image_key' => $imageKey,
            'fetched_at' => now(),
            'expires_at' => now()->addHours(LinkPreview::TTL_READY_HOURS),
        ])->save();

        return 'ok';
    }

    /** A failed refresh keeps the good card (and its image) and just retries later. */
    private function backOff(LinkPreview $row): void
    {
        $row->forceFill(['expires_at' => now()->addMinutes(LinkPreview::TTL_NONE_MINUTES)])->save();
    }

    private function dropImage(?string $old, ?string $new): void
    {
        if ($old === null || $old === $new) {
            return;
        }
        try {
            app(ImageStore::class)->delete($old);
        } catch (\Throwable) {
            // the daily prune is the backstop
        }
    }

    private function markNone(LinkPreview $row): void
    {
        $this->dropImage($row->image_key, null);
        $row->forceFill([
            'status' => LinkPreview::NONE,
            'title' => null, 'description' => null, 'site_name' => null, 'image_key' => null,
            'fetched_at' => now(),
            'expires_at' => now()->addMinutes(LinkPreview::TTL_NONE_MINUTES),
        ])->save();
    }
}
