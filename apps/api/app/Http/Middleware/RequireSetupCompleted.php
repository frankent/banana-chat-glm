<?php

namespace App\Http\Middleware;

use App\Services\SetupState;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * FR-SETUP-001 — until the first-run installer has run, every page redirects
 * to /setup and every API call answers 503 SETUP_REQUIRED. The wizard and
 * the health probes stay reachable so operators (and orchestrators) can see
 * what state the instance is in.
 */
class RequireSetupCompleted
{
    private const ALWAYS_AVAILABLE = [
        'setup',
        'api/v1/setup/status',
        'api/v1/setup/test-database',
        'api/v1/setup/test-redis',
        'api/v1/setup/install',
        'api/v1/health',
        'up',
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $path = $request->path();

        if (in_array($path, self::ALWAYS_AVAILABLE, true) || str_starts_with($path, 'setup/')) {
            return $next($request);
        }

        if (SetupState::make()->isCompleted()) {
            return $next($request);
        }

        if ($request->expectsJson() || $request->is('api/*')) {
            return response()->json([
                'error' => [
                    'code' => 'SETUP_REQUIRED',
                    'message' => 'ยังไม่ได้ติดตั้งระบบ — เปิด /setup เพื่อเริ่มการตั้งค่าครั้งแรก',
                    'request_id' => $request->attributes->get('request_id') ?? $request->header('X-Request-Id'),
                ],
            ], 503, ['Location' => url('/setup')]);
        }

        return redirect('/setup');
    }
}
