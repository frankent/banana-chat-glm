<?php

namespace App\Providers;

use App\Auth\SystemAdminUserProvider;
use App\Domain\Media\MediaUrls;
use App\Services\SettingsService;
use App\Services\SetupState;
use App\Support\WorkspaceContext;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(WorkspaceContext::class);
        $this->app->singleton(SettingsService::class);

        Auth::provider('system-admin', fn ($app, array $config) => new SystemAdminUserProvider($app['hash'], $config['model']));

        // FR-SETUP — paths from config/setup.php (tests point these at temp files)
        $this->app->bind(SetupState::class, fn () => SetupState::make());

        // FR-SETUP — uninstalled WEB boots (no APP_KEY yet) need a throwaway
        // key + file cache before EncryptCookies / the setup limiter resolve.
        // Console boots are excluded: `key:generate` builds its .env rewrite
        // regex from config('app.key'), so seeding one there makes it refuse
        // to write and leaves the setup gate active (found in CI).
        if (! $this->app->runningInConsole()) {
            SetupState::applyPreInstallDefaults();
        }
    }

    public function boot(): void
    {
        // local disk has no native presigned URLs — route through signed API
        // endpoints instead (s3 disk signs natively; see MediaUrls)
        $local = Storage::disk('local');
        if ($local instanceof FilesystemAdapter) {
            MediaUrls::registerLocalCallbacks($local);
        }

        // FR-AUTH-006: 5/min per IP + 10/15min per username
        RateLimiter::for('login', function (Request $request) {
            $username = mb_strtolower(trim((string) $request->input('username', '')));

            return [
                Limit::perMinute(5)->by('ip:'.$request->ip()),
                Limit::perMinutes(15, 10)->by('username:'.$username),
            ];
        });

        RateLimiter::for('refresh', function (Request $request) {
            return Limit::perMinute(30)->by('ip:'.$request->ip());
        });

        RateLimiter::for('api', function (Request $request) {
            return Limit::perMinute(300)->by($request->user()?->id ?: $request->ip());
        });

        // FR-AI-010: AI send endpoints — 20/min per user
        RateLimiter::for('ai-send', function (Request $request) {
            return Limit::perMinute(20)->by('ai:'.$request->user()?->id);
        });

        /*
        |------------------------------------------------------------------
        | FR-PCHAT-031 — PUBLIC CHAT LIMITERS. NAMED, NEVER numeric.
        |------------------------------------------------------------------
        | routes/api.php already documents why: stacked numeric `throttle:N,1`
        | share ONE cache key per resolved user-or-IP across every numerically
        | throttled route on the domain, so a numeric limit here would be both
        | wrong and shared with unrelated endpoints.
        |
        | THE KEYS ARE THE POINT.
        |  - Tier 1 keys on X-PChat-Key, not the IP: the partner calls from ONE
        |    server IP, so an IP key would give an entire integration the budget
        |    of a single browser tab. (The IP fallback exists only so an
        |    unsigned prober is still bounded.)
        |  - Tier 2 keys on the ROOM CODE, not the IP: one noisy visitor must not
        |    exhaust another customer's budget, and keying by code also means
        |    link-guessing cannot be amortised across codes.
        |
        | HONEST CEILING (R3): nginx limit_req zone=edge_api is 300r/m burst=150
        | keyed on $binary_remote_addr. A busy partner hits that from its single
        | IP no matter what these numbers say; app-level limiters cannot raise an
        | edge limit. Size capacity against it or ship the X-PChat-Key-keyed
        | nginx exemption with the feature.
        */
        RateLimiter::for('pchat-create', fn (Request $request) => Limit::perMinute(60)
            ->by('pchat-create:'.($request->header('X-PChat-Key') ?: $request->ip())));

        // Partner status polls / close / rotate-link. Separate from the create
        // budget so a tight polling loop cannot starve room creation.
        RateLimiter::for('pchat-partner', fn (Request $request) => Limit::perMinute(120)
            ->by('pchat-partner:'.($request->header('X-PChat-Key') ?: $request->ip())));

        RateLimiter::for('pchat-visitor-read', fn (Request $request) => Limit::perMinute(120)
            ->by('pchat-read:'.$request->route('code')));

        RateLimiter::for('pchat-visitor-write', fn (Request $request) => Limit::perMinute(20)
            ->by('pchat-write:'.$request->route('code')));

        RateLimiter::for('pchat-visitor-upload', fn (Request $request) => Limit::perMinute(10)
            ->by('pchat-upload:'.$request->route('code')));

        // Route middleware runs AFTER the group's auth:api, so ->user() is set.
        RateLimiter::for('pchat-agent-write', fn (Request $request) => Limit::perMinute(60)
            ->by('pchat-agent:'.($request->user()?->id ?: $request->ip())));

        // Typing gets its OWN budget. Sharing pchat-agent-write would let a
        // client emitting a keystroke indicator every 3 seconds burn a third of
        // the send allowance, so a busy agent would 429 on a real reply.
        RateLimiter::for('pchat-agent-typing', fn (Request $request) => Limit::perMinute(60)
            ->by('pchat-typing:'.($request->user()?->id ?: $request->ip())));

        // FR-WS-006/FR-AUTH-008 (DEC-081) — invite issuance is per-admin (they're
        // authenticated); preview/join are pre-auth, so IP is the only key we have.
        RateLimiter::for('invite-issue', fn (Request $request) => Limit::perMinute(10)
            ->by('invite-issue:'.$request->user()?->id));
        RateLimiter::for('invite-preview', fn (Request $request) => Limit::perMinute(30)->by('invite-preview:'.$request->ip()));
        RateLimiter::for('invite-join', fn (Request $request) => Limit::perMinute(5)->by('invite-join:'.$request->ip()));

        // FR-SETUP — wizard endpoints: 10/min, install itself 3/min
        RateLimiter::for('setup', fn (Request $request) => Limit::perMinute(10)->by('setup-ip:'.$request->ip()));
        RateLimiter::for('setup-install', fn (Request $request) => Limit::perMinute(3)->by('setup-install-ip:'.$request->ip()));
    }
}
