<?php

namespace Tests;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\RateLimiter;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        // Login-rate limits interfere with dense test loops (e.g. 11 logins in
        // TC-AUTH-008). HTTP throttling is infra protection, tested in CI separately.
        if (config('app.env') === 'testing') {
            RateLimiter::for('login', fn () => Limit::none());
            RateLimiter::for('refresh', fn () => Limit::none());
        }

        // TASK-QA-008 — any test that lets a real HTTP call slip through
        // (no Http::fake) fails loudly. Tests must never reach the network,
        // in CI or locally. Broadcast/pusher traffic bypasses the Http
        // factory so realtime tests are unaffected.
        Http::preventStrayRequests();

        // FR-MEDIA-006 — point clamd at a refused port so file-kind uploads
        // in unrelated tests skip the scan instantly instead of waiting out
        // DNS for the "clamav" hostname. VirusScanTest overrides per-test.
        config(['services.clamav.host' => '127.0.0.1', 'services.clamav.port' => 1]);
    }

    /**
     * The AuthManager singleton persists across the several requests a single
     * test may issue; without this the api guard would keep serving the user
     * resolved by the first request (stale after logout/revoke assertions).
     */
    public function call($method, $uri, $parameters = [], $cookies = [], $files = [], $server = [], $content = null)
    {
        $this->app?->make('auth')->forgetGuards();

        return parent::call($method, $uri, $parameters, $cookies, $files, $server, $content);
    }
}
