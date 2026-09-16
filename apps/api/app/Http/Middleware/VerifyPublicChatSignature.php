<?php

namespace App\Http\Middleware;

use App\Enums\WorkspaceStatus;
use App\Exceptions\ApiException;
use App\Models\PublicChatApiKey;
use App\Support\WorkspaceContext;
use Closure;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

/**
 * FR-PCHAT-031 — HMAC-SHA256 request signing for the Tier-1 partner surface
 * (`/api/v1/partner/public-chat/*`). Alias: `api.hmac`.
 *
 * NOT A GUARD, deliberately. Auth::viaRequest must return an Authenticatable
 * and there is no User here — a partner's server is not a person. For the same
 * reason this middleware NEVER throws AuthenticationException: the renderer at
 * bootstrap/app.php renders that as AUTH_TOKEN_INVALID, which is actively
 * misleading for a machine client that holds no token. Every failure is an
 * ApiException carrying an API_* code from spec §7.1.
 *
 * ---- CANONICAL STRING — exactly 6 lines, "\n"-joined -----------------------
 *   v1
 *   <HTTP METHOD, uppercase>
 *   <request path INCLUDING the /api/v1 prefix, NO query string>
 *   <X-PChat-Timestamp>
 *   <X-PChat-Nonce>
 *   <lowercase hex sha256 of the RAW request body bytes; sha256("") if no body>
 *
 * The body digest is taken over $request->getContent() — THE RAW BYTES — never
 * over re-serialised JSON. Re-serialising changes key order, whitespace and
 * unicode escaping and produces intermittent, unreproducible signature
 * failures; this is the single most common integration bug in this class of
 * API. The partner docs must say "sign the exact bytes you put on the wire".
 *
 * ---- HEADERS ---------------------------------------------------------------
 *   X-PChat-Key        key_id ('pck_' + 28 lowercase hex). PUBLIC, safe to log.
 *   X-PChat-Timestamp  unix seconds, integer
 *   X-PChat-Nonce      16..64 chars from [A-Za-z0-9_-]
 *   X-PChat-Signature  "v1=" + lowercase hex HMAC-SHA256
 *
 * ---- VERIFICATION ORDER — fail-closed, cheapest first ----------------------
 *   1. headers present and well-formed        -> 401 API_KEY_INVALID
 *   2. |now - timestamp| <= 300s              -> 401 API_TIMESTAMP_SKEW
 *   3. key_id lookup / not revoked / ws active-> 401 API_KEY_INVALID
 *   4. hash_equals over the recomputed MAC    -> 401 API_SIGNATURE_INVALID
 *   5. nonce not already seen (600s cache)    -> 409 API_NONCE_REPLAYED
 *   6. WorkspaceContext::set + throttled last_used_at
 *   7. ONLY THEN the controller calls the feature gate -> 503 PCHAT_DISABLED
 *
 * The feature gate is deliberately LAST. Order matters twice: an
 * unauthenticated prober must not learn whether the feature is switched on, and
 * a legitimate partner must get a clean retriable 503 rather than a misleading
 * 401.
 *
 * Step 5 runs AFTER step 4 on purpose: a request with a bad signature must not
 * burn a nonce, or an attacker who can observe traffic could pre-consume a
 * legitimate client's nonces with unsigned garbage and turn every real request
 * into a 409 (TC-PCHAT-050).
 */
class VerifyPublicChatSignature
{
    /** Signature version tag; also the first canonical line. */
    public const VERSION = 'v1';

    /** ±300s. The replay window the nonce cache TTL is derived from. */
    public const MAX_SKEW_SECONDS = 300;

    /**
     * 600s > 2x the skew window, so any replay that is still inside the
     * accepted timestamp window is guaranteed to find its nonce cached. The two
     * numbers are tied together on purpose and must not drift apart.
     */
    public const NONCE_TTL_SECONDS = 600;

    public const HEADER_KEY = 'X-PChat-Key';

    public const HEADER_TIMESTAMP = 'X-PChat-Timestamp';

    public const HEADER_NONCE = 'X-PChat-Nonce';

    public const HEADER_SIGNATURE = 'X-PChat-Signature';

    /** Where the verified key is handed to the controller. */
    public const REQUEST_ATTRIBUTE = 'public_chat_api_key';

    public function __construct(
        private readonly WorkspaceContext $context,
    ) {}

    public function handle(Request $request, Closure $next): Response
    {
        // ---- 1. headers present and well-formed ---------------------------
        // Envelope-shape failures all report API_KEY_INVALID rather than a more
        // specific code: an unauthenticated prober gains nothing from knowing
        // WHICH header it malformed, and a real integrator sees the exact
        // required shapes in the docs. The one exception is the signature
        // itself, whose format failure falls out of step 4 as
        // API_SIGNATURE_INVALID — the code an integrator debugging signing
        // expects to see.
        $keyId = trim((string) $request->header(self::HEADER_KEY, ''));
        $timestamp = trim((string) $request->header(self::HEADER_TIMESTAMP, ''));
        $nonce = trim((string) $request->header(self::HEADER_NONCE, ''));
        $signature = trim((string) $request->header(self::HEADER_SIGNATURE, ''));

        if ($keyId === '' || $timestamp === '' || $nonce === '' || $signature === '') {
            throw ApiException::apiKeyInvalid();
        }

        if (preg_match('/\A'.preg_quote(PublicChatApiKey::KEY_ID_PREFIX, '/').'[0-9a-f]{28}\z/', $keyId) !== 1) {
            throw ApiException::apiKeyInvalid();
        }

        if (preg_match('/\A-?[0-9]{1,19}\z/', $timestamp) !== 1) {
            throw ApiException::apiKeyInvalid();
        }

        // \A..\z, never ^..$ — '$' also matches before a trailing newline, which
        // is precisely how a header-smuggled value slips past a naive anchor.
        if (preg_match('/\A[A-Za-z0-9_-]{16,64}\z/', $nonce) !== 1) {
            throw ApiException::apiKeyInvalid();
        }

        // ---- 2. clock skew -------------------------------------------------
        $now = now()->getTimestamp();
        $skew = $now - (int) $timestamp;

        if (abs($skew) > self::MAX_SKEW_SECONDS) {
            throw ApiException::apiTimestampSkew($skew);
        }

        // ---- 3. key lookup -------------------------------------------------
        $key = PublicChatApiKey::findActiveByKeyId($keyId);

        if ($key === null) {
            throw ApiException::apiKeyInvalid();
        }

        $workspace = $key->workspace()->withoutGlobalScopes()->first();

        if ($workspace === null || $workspace->status !== WorkspaceStatus::Active) {
            throw ApiException::apiKeyInvalid();
        }

        // ---- 4. signature --------------------------------------------------
        try {
            $secret = $key->plainSecret();
        } catch (DecryptException $e) {
            // MANDATORY graft 8. After an APP_KEY rotation this throws for EVERY
            // row; without the catch, a rotation turns every partner request
            // into a 500 with a stack trace. The operator needs to know
            // immediately, because the remedy is to reissue every key (DEC-062's
            // runbook consequence) — hence critical, and hence key_id only,
            // never the ciphertext.
            Log::critical('public_chat.api_key_undecryptable', [
                'key_id' => $key->key_id,
                'workspace_id' => $key->workspace_id,
                'hint' => 'APP_KEY rotation invalidates every partner secret (DEC-062) — reissue all keys.',
            ]);

            throw ApiException::apiKeyInvalid();
        }

        $expected = self::VERSION.'='.hash_hmac('sha256', $this->canonicalString($request, $timestamp, $nonce), $secret);

        // Known value first, presented value second; constant time either way.
        if (! hash_equals($expected, $signature)) {
            throw ApiException::apiSignatureInvalid();
        }

        // ---- 5. nonce replay ------------------------------------------------
        // The nonce is hashed into the cache key so a partner-chosen value can
        // never shape our key space. Default cache store on purpose — the same
        // one SettingsService uses (redis in production, array under phpunit).
        $nonceKey = 'pchat:nonce:'.$keyId.':'.hash('sha256', $nonce);

        if (Cache::add($nonceKey, 1, self::NONCE_TTL_SECONDS) === false) {
            throw ApiException::apiNonceReplayed();
        }

        // ---- 6. context + provenance ---------------------------------------
        // WorkspaceContext::set accepts a null membership (Support/WorkspaceContext.php)
        // — a partner server is not a member of anything. This makes
        // WorkspaceScope effective for everything the controller reads AFTERWARDS;
        // it does NOT excuse the controller from filtering workspace_id
        // explicitly (DEC-070), because the room lookup that follows may be by
        // code or by ULID and must be pinned to this key's workspace either way.
        $this->context->set($workspace, null);

        $key->touchLastUsedThrottled();

        $request->attributes->set(self::REQUEST_ATTRIBUTE, $key);

        // ---- 7. the feature gate is the CONTROLLER's job, not ours ----------
        return $next($request);
    }

    /**
     * The exact bytes the partner must sign. Exposed as a public static so the
     * test suite, the partner-facing documentation example and the middleware
     * cannot drift apart.
     */
    public static function canonical(string $method, string $path, string $timestamp, string $nonce, string $rawBody): string
    {
        return implode("\n", [
            self::VERSION,
            strtoupper($method),
            $path,
            $timestamp,
            $nonce,
            hash('sha256', $rawBody),
        ]);
    }

    private function canonicalString(Request $request, string $timestamp, string $nonce): string
    {
        return self::canonical(
            $request->getMethod(),
            // getPathInfo() keeps the leading slash and the /api/v1 prefix and
            // excludes the query string. $request->path() drops the leading
            // slash — using it here would silently break every partner signature.
            $request->getPathInfo(),
            $timestamp,
            $nonce,
            (string) $request->getContent(),
        );
    }
}
