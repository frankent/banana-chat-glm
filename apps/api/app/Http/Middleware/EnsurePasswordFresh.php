<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Chain #3: must_change_password tokens may only reach change-password,
 * /me, and logout endpoints (FR-AUTH-001 AC5).
 */
class EnsurePasswordFresh
{
    private const EXEMPT = [
        'api/v1/auth/change-password',
        'api/v1/auth/logout',
        'api/v1/auth/logout-all',
        'api/v1/auth/refresh',
        'api/v1/me',
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user !== null && $user->must_change_password) {
            $path = $request->route()?->uri() ?? $request->path();

            if (! in_array($path, self::EXEMPT, true)) {
                throw ApiException::passwordChangeRequired();
            }
        }

        return $next($request);
    }
}
