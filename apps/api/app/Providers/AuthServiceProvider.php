<?php

namespace App\Providers;

use App\Domain\Auth\TokenService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\ServiceProvider;

class AuthServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // API guard (D3): opaque bearer token → user + chat_session on the request
        Auth::viaRequest('api', function (Request $request) {
            $bearer = $request->bearerToken();

            if ($bearer === null || $bearer === '') {
                return null;
            }

            $resolved = app(TokenService::class)->resolveAccessToken($bearer);

            if ($resolved === null) {
                return null;
            }

            $request->attributes->set('chat_session', $resolved['session']);
            $request->attributes->set('access_token', $resolved['accessToken']);

            return $resolved['user'];
        });
    }
}
