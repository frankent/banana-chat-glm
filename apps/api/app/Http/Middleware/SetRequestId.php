<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * §7 — every response carries X-Request-Id (echoed if provided).
 */
class SetRequestId
{
    public function handle(Request $request, Closure $next): Response
    {
        $requestId = $request->header('X-Request-Id') ?? (string) Str::ulid();

        $request->attributes->set('request_id', $requestId);

        $response = $next($request);

        return $response->headers->set('X-Request-Id', $requestId) ?: $response;
    }
}
