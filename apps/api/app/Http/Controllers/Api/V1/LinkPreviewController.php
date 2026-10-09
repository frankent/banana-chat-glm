<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\LinkPreview\HostPolicy;
use App\Domain\LinkPreview\ImageStore;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Jobs\FetchLinkPreview;
use App\Models\LinkPreview;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\RateLimiter;

/**
 * API-241 / FR-MSG-013 / DEC-100 — external link preview.
 *
 * The request thread NEVER touches the network: it validates, consults the cache
 * and at most dispatches FetchLinkPreview. Upstream trouble of any kind is an
 * ordinary `{status:'none'}` — never an error, never any upstream detail — so
 * this endpoint cannot be used as an internal-network oracle.
 */
class LinkPreviewController extends Controller
{
    public const USER_FETCH_BUDGET = 20;

    public const WORKSPACE_FETCH_BUDGET = 300;

    public const HOST_FETCH_BUDGET = 30;

    public function __construct(
        private readonly SettingsService $settings,
        private readonly WorkspaceContext $context,
        private readonly ImageStore $images,
    ) {}

    public function show(Request $request): JsonResponse
    {
        $raw = $request->query('url');
        if (! is_string($raw) || $raw === '' || strlen($raw) > 2048) {
            throw $this->invalid('url');
        }

        $policy = HostPolicy::fromApp($request->getHost());
        $parts = $policy->parse($raw);
        if (! $parts['ok']) {
            throw $this->invalid($parts['reason']);
        }
        // Hard internal exclusion (R9): this app's own hosts hold tickets, meetings
        // and bearer links (/support, /join) and are never unfurled.
        if ($policy->isInternalHost($parts['host'])) {
            throw $this->invalid('internal');
        }

        $url = $parts['url'];
        if (! $this->settings->bool('link_preview.enabled')
            || $policy->isBlockedHost($parts['host'])
            || HostPolicy::looksSensitive($parts['path'], $parts['query'])) {
            return $this->none($url);
        }

        $hash = hash('sha256', $url);
        $row = LinkPreview::query()->where('url_hash', $hash)->first();
        if ($row !== null && $row->isFresh()) {
            return $this->respond($row);
        }

        // Cache miss / stale: this is the only path that can cause an outbound fetch.
        $uid = (string) $request->user()->id;
        $wid = (string) ($this->context->id() ?? '');
        if (! RateLimiter::attempt('lp-fetch:u:'.$uid, self::USER_FETCH_BUDGET, fn () => true, 60)
            || ! RateLimiter::attempt('lp-fetch:w:'.$wid, self::WORKSPACE_FETCH_BUDGET, fn () => true, 60)) {
            abort(429, 'rate limited', ['Retry-After' => 60]);
        }
        // Per target host across ALL users: one site cannot be turned into a hammering tool.
        if (! RateLimiter::attempt('lp-fetch:h:'.$parts['host'], self::HOST_FETCH_BUDGET, fn () => true, 60)) {
            abort(429, 'rate limited', ['Retry-After' => 60]);
        }

        $lock = Cache::lock('lp:'.$hash, 30);
        if (! $lock->get()) {
            return $this->pending($url); // someone else is already dispatching
        }
        try {
            // Re-check under the lock: the winner of a race has already written the row.
            $row = LinkPreview::query()->where('url_hash', $hash)->first();
            if ($row !== null && $row->isFresh()) {
                return $this->respond($row);
            }
            if ($row !== null && $row->status === LinkPreview::READY) {
                // Refresh, never downgrade: keep serving the good card for 60 s while ONE job re-fetches.
                $row->forceFill(['expires_at' => now()->addSeconds(LinkPreview::TTL_PENDING_SECONDS)])->save();
                FetchLinkPreview::dispatch($row->id, true);

                return $this->respond($row);
            }
            $row = LinkPreview::query()->updateOrCreate(['url_hash' => $hash], [
                'url' => $url,
                'status' => LinkPreview::PENDING,
                'expires_at' => now()->addSeconds(LinkPreview::TTL_PENDING_SECONDS),
            ]);
            FetchLinkPreview::dispatch($row->id);
        } finally {
            $lock->release();
        }

        return $this->pending($url);
    }

    private function respond(LinkPreview $row): JsonResponse
    {
        if ($row->status === LinkPreview::PENDING) {
            return $this->pending($row->url);
        }
        if ($row->status !== LinkPreview::READY) {
            return $this->none($row->url);
        }

        $imageUrl = null;
        $imageExpires = null;
        if ($row->image_key !== null) {
            $imageExpires = now()->addMinutes(ImageStore::URL_TTL_MINUTES);
            $imageUrl = $this->images->signedUrl($row->image_key, $imageExpires);
            $imageExpires = $imageUrl !== null ? $imageExpires->toIso8601String() : null;
        }

        return $this->json(200, [
            'status' => 'ready',
            'url' => $row->url,
            'title' => $row->title,
            'description' => $row->description,
            'site_name' => $row->site_name,
            'image_url' => $imageUrl,
            'image_expires_at' => $imageExpires,
            'fetched_at' => $row->fetched_at?->toIso8601String(),
        ]);
    }

    private function none(string $url): JsonResponse
    {
        return $this->json(200, ['status' => 'none', 'url' => $url]);
    }

    private function pending(string $url): JsonResponse
    {
        return $this->json(202, ['status' => 'pending', 'url' => $url]);
    }

    /** @param array<string,mixed> $data */
    private function json(int $status, array $data): JsonResponse
    {
        return response()->json(['data' => $data], $status)->header('Cache-Control', 'private, no-store');
    }

    private function invalid(string $reason): ApiException
    {
        // $reason describes the caller's OWN input (scheme/port/internal/...), not the network.
        return new ApiException('LINK_PREVIEW_INVALID', 'ลิงก์นี้ไม่สามารถแสดงตัวอย่างได้', 422, ['reason' => $reason]);
    }
}
