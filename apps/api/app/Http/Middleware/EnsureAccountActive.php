<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Chain #2: auth:api → account.active → password.fresh (FR-AUTH-007).
 */
class EnsureAccountActive
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if ($user !== null && $user->status->value !== 'active') {
            throw ApiException::accountDisabled();
        }

        return $next($request);
    }
}
