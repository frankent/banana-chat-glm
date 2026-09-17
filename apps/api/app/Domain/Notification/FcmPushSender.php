<?php

namespace App\Domain\Notification;

use App\Models\Device;
use Firebase\JWT\JWT;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * FR-NOTI-002/003 — FCM HTTP **v1** sender.
 *
 * This class previously posted to the legacy endpoint
 * `https://fcm.googleapis.com/fcm/send` with an `Authorization: key=<server key>`
 * header, while its own docblock claimed to be a v1 sender. Google decommissioned
 * that API, so every send failed — and because a missing key short-circuits to a
 * logged no-op, it failed *silently*. Appendix A of the spec has always named the
 * v1 credentials (`FCM_PROJECT_ID`, `FCM_CREDENTIALS_JSON`), and the §10 payload
 * has always been v1-shaped with `android` and `apns` blocks, so this is spec
 * compliance rather than new behaviour.
 *
 * v1 differences that matter here:
 *  - endpoint carries the project id and takes a single `{"message": {...}}` body
 *  - auth is a short-lived OAuth2 bearer token minted from a service-account JSON
 *    (RS256 JWT assertion — signed with firebase/php-jwt, already a dependency, so
 *    google/auth is not needed)
 *  - one token per request; there is no `results[]` array, and a dead token is a
 *    real HTTP 404/400 with `error.details[].errorCode`, not a 200 with an error
 *    string inside it
 *
 * Stub mode is kept so dev/CI run without credentials, but it now warns rather
 * than logging at info — a silent no-op is exactly how this went unnoticed.
 * UNREGISTERED/INVALID_ARGUMENT tokens delete the row; other failures bump
 * push_failed_count (disabled at 5).
 */
class FcmPushSender
{
    /** OAuth2 scope required to call the FCM v1 send endpoint. */
    private const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

    /** Access tokens live 1h; re-mint a minute early so one never expires in flight. */
    private const TOKEN_TTL = 3_540;

    public static function endpoint(string $projectId): string
    {
        return "https://fcm.googleapis.com/v1/projects/{$projectId}/messages:send";
    }

    /**
     * @param  array{title: string, body: string, data: array<string, mixed>, collapse_key: string, badge: int}  $payload
     */
    public function send(Device $device, array $payload): void
    {
        $projectId = (string) config('services.fcm.project_id');
        $credentials = $this->credentials();

        if ($projectId === '' || $credentials === null) {
            // Loud on purpose: the legacy sender's info-level no-op is why a dead
            // push path survived in production unnoticed.
            Log::warning('push.stub — FCM credentials not configured, nothing was sent', [
                'device_id' => $device->id,
                'title' => $payload['title'],
                'missing' => $projectId === '' ? 'FCM_PROJECT_ID' : 'FCM_CREDENTIALS_JSON',
            ]);

            return;
        }

        $token = $this->accessToken($credentials);

        $response = Http::withToken($token)
            ->post(self::endpoint($projectId), [
                'message' => $this->message($device, $payload),
            ]);

        if ($response->successful()) {
            $device->forceFill(['push_failed_count' => 0, 'push_disabled_at' => null])->save();

            return;
        }

        // v1 reports a dead token as a real error status. UNREGISTERED means the app
        // was uninstalled / the browser subscription was revoked; INVALID_ARGUMENT on
        // a send we built ourselves means the token itself is malformed. Neither is
        // retryable, and both should stop us pushing to this row. (TC-NOTI-016)
        $errorCode = (string) ($response->json('error.status') ?? '');
        $details = collect($response->json('error.details') ?? [])->pluck('errorCode')->filter()->all();
        $dead = in_array('UNREGISTERED', $details, true)
            || in_array('INVALID_ARGUMENT', $details, true)
            || $errorCode === 'NOT_FOUND'
            || str_contains((string) $response->body(), 'UNREGISTERED');

        if ($dead) {
            $device->forceFill(['push_token' => null, 'push_provider' => null])->save();

            return;
        }

        $count = $device->push_failed_count + 1;
        $device->forceFill([
            'push_failed_count' => $count,
            'push_disabled_at' => $count >= 5 ? now() : null, // TC-NOTI-017
        ])->save();

        throw new \RuntimeException("fcm send failed: {$response->status()} {$errorCode}");
    }

    /**
     * §10 payload. `data` values must all be strings in v1 — an int anywhere in the
     * map is rejected with INVALID_ARGUMENT for the whole send.
     *
     * @param  array{title: string, body: string, data: array<string, mixed>, collapse_key: string, badge: int}  $payload
     * @return array<string, mixed>
     */
    private function message(Device $device, array $payload): array
    {
        $type = (string) ($payload['data']['type'] ?? 'message');
        $channel = match ($type) {
            'mention' => 'mentions',
            'ai_completed' => 'ai',
            'room_added', 'workspace_added', 'session_revoked' => 'system',
            default => 'messages',
        };

        $data = array_map(
            static fn ($v) => is_bool($v) ? ($v ? 'true' : 'false') : (string) $v,
            $payload['data'] + [
                'type' => $type,
                'title' => $payload['title'],
                'body' => $payload['body'],
                'badge' => $payload['badge'],
            ],
        );

        return [
            'token' => $device->push_token,
            'notification' => [
                'title' => $payload['title'],
                'body' => $payload['body'],
            ],
            'data' => $data,
            'android' => [
                'priority' => $type === 'mention' ? 'high' : 'normal',
                'collapse_key' => $payload['collapse_key'],
                'notification' => [
                    'channel_id' => $channel,
                    'tag' => $payload['collapse_key'],
                ],
            ],
            'apns' => [
                'headers' => [
                    'apns-collapse-id' => $payload['collapse_key'],
                    'apns-priority' => '10',
                ],
                'payload' => [
                    'aps' => [
                        'alert' => ['title' => $payload['title'], 'body' => $payload['body']],
                        'badge' => $payload['badge'],
                        'sound' => 'default',
                        'thread-id' => $payload['collapse_key'],
                        'mutable-content' => 1,
                    ],
                ],
            ],
            'webpush' => [
                'headers' => ['Topic' => $payload['collapse_key']],
                'fcm_options' => ['link' => '/'],
            ],
        ];
    }

    /**
     * Service-account JSON, from a path or an inline blob. Appendix A documents
     * FCM_CREDENTIALS_JSON as a path; an inline JSON value is accepted too because
     * container deployments often inject secrets as env values rather than files.
     *
     * @return array{client_email: string, private_key: string, token_uri?: string}|null
     */
    private function credentials(): ?array
    {
        $raw = (string) config('services.fcm.credentials');

        if ($raw === '') {
            return null;
        }

        $json = str_starts_with(ltrim($raw), '{')
            ? $raw
            : (is_readable($raw) ? (string) file_get_contents($raw) : '');

        $decoded = json_decode($json, true);

        if (! is_array($decoded) || ! isset($decoded['client_email'], $decoded['private_key'])) {
            Log::error('push.credentials_invalid — FCM_CREDENTIALS_JSON is not a readable service-account JSON');

            return null;
        }

        return $decoded;
    }

    /**
     * Mint (and cache) an OAuth2 access token from the service account. Cached under
     * a key derived from the client_email so rotating the credentials does not serve
     * a stale token.
     *
     * @param  array{client_email: string, private_key: string, token_uri?: string}  $credentials
     */
    private function accessToken(array $credentials): string
    {
        $cacheKey = 'fcm:token:'.sha1($credentials['client_email']);

        return (string) Cache::remember($cacheKey, self::TOKEN_TTL, function () use ($credentials): string {
            $tokenUri = $credentials['token_uri'] ?? 'https://oauth2.googleapis.com/token';
            $now = time();

            $assertion = JWT::encode([
                'iss' => $credentials['client_email'],
                'scope' => self::SCOPE,
                'aud' => $tokenUri,
                'iat' => $now,
                'exp' => $now + 3600,
            ], $credentials['private_key'], 'RS256');

            $response = Http::asForm()->post($tokenUri, [
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion' => $assertion,
            ]);

            if (! $response->successful() || ! is_string($response->json('access_token'))) {
                throw new \RuntimeException('fcm oauth failed: '.$response->status());
            }

            return (string) $response->json('access_token');
        });
    }
}
