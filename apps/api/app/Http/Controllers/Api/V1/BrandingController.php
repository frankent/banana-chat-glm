<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\AppSetting;
use App\Services\SettingsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * API-234/235, FR-ADM-015/DEC-082 — PUBLIC, unauthenticated. The logo must
 * render on /login, /join/:token and other pre-auth pages, so this cannot
 * sit behind auth:api like the rest of the admin-managed settings.
 */
class BrandingController extends Controller
{
    /** API-234 — {logo_url: string|null}, cache-busted via the setting's own updated_at. */
    public function config(SettingsService $settings): JsonResponse
    {
        $path = $settings->get('branding.logo_path');

        if (! is_string($path) || $path === '') {
            return response()->json(['data' => ['logo_url' => null]]);
        }

        // ->value() is a plain query-builder read (no Eloquent hydration, so
        // no cast) — ->first() so `updated_at` comes back as the cast Carbon.
        $version = AppSetting::query()->where('key', 'branding.logo_path')->first()?->updated_at?->getTimestamp() ?? 0;

        // Relative, not url()/APP_URL-derived — same-origin asset, and this
        // sidesteps any APP_URL/reverse-proxy hostname mismatch entirely.
        return response()->json([
            'data' => ['logo_url' => "/api/v1/branding/logo?v={$version}"],
        ]);
    }

    /**
     * API-235 — streams the current logo from local disk (never the public/
     * s3 disk: prod's nginx /storage/ route proxies MinIO, not Laravel local
     * storage, and the attachment system's WorkspaceScope has no meaning for
     * a system-wide asset). 404 when unset; the frontend falls back to the
     * built-in mark either way, so this is safe to cache hard behind the
     * caller-supplied ?v= cache-buster.
     */
    public function logo(SettingsService $settings): StreamedResponse
    {
        $path = $settings->get('branding.logo_path');

        if (! is_string($path) || $path === '' || ! Storage::disk('local')->exists($path)) {
            abort(404);
        }

        return Storage::disk('local')->response($path, null, [
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
    }
}
