<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Services\SettingsService;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * TASK-BE-025 / §7 — mobile clients send X-App-Version; a version below
 * app.min_supported_version gets `426 APP_UPDATE_REQUIRED` on every API call.
 * Requests without the header (web, admin, health probes) pass untouched.
 */
class RequireMinimumAppVersion
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        $version = $request->header('X-App-Version');

        if ($version !== null && $version !== '') {
            $min = (string) $this->settings->get('app.min_supported_version', '');

            if ($min !== '' && $this->compare($version, $min) < 0) {
                throw new ApiException('APP_UPDATE_REQUIRED', 'กรุณาอัปเดตแอปเป็นเวอร์ชันล่าสุด', 426, [
                    'min_supported_version' => $min,
                ]);
            }
        }

        return $next($request);
    }

    /**
     * Semantic-ish comparison — dot-separated numeric segments ("1.2" < "1.10").
     * Non-numeric segments (channels like "1.2.0-beta") compare as 0.
     */
    private function compare(string $a, string $b): int
    {
        $a = array_map(fn ($p) => (int) filter_var($p, FILTER_SANITIZE_NUMBER_INT) ?: 0, explode('.', $a));
        $b = array_map(fn ($p) => (int) filter_var($p, FILTER_SANITIZE_NUMBER_INT) ?: 0, explode('.', $b));
        $len = max(count($a), count($b));
        $a = array_pad($a, $len, 0);
        $b = array_pad($b, $len, 0);

        return $a <=> $b;
    }
}
