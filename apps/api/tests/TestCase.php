<?php

namespace Tests;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
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
