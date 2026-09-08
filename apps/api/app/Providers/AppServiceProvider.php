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

        // FR-SETUP — wizard endpoints: 10/min, install itself 3/min
        RateLimiter::for('setup', fn (Request $request) => Limit::perMinute(10)->by('setup-ip:'.$request->ip()));
        RateLimiter::for('setup-install', fn (Request $request) => Limit::perMinute(3)->by('setup-install-ip:'.$request->ip()));
    }
}
