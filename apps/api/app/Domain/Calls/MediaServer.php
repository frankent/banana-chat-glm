<?php

namespace App\Domain\Calls;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Illuminate\Support\Facades\Http;

/** FR-CALL-004: grant signing stays server-side; never log tokens. */
class MediaServer
{
    /**
     * FR-CALL-009 / DEC-086: $ttl defaults to the historic 60s (admin/API-to-SFU
     * requests keep it); participant join tokens pass `calls.token_ttl` instead
     * so a phone frozen in the background can still reconnect — revocation is
     * unchanged because authorizeMedia re-checks DB membership on every connect.
     */
    public function token(array $claims, int $ttl = 60): string
    {
        return JWT::encode(array_merge(['iss' => config('calls.key'), 'nbf' => time() - 5, 'exp' => time() + $ttl], $claims), config('calls.secret'), 'HS256');
    }

    public function decode(string $token): object
    {
        $claims = JWT::decode($token, new Key(config('calls.secret'), 'HS256'));
        abort_unless(($claims->iss ?? null) === config('calls.key'), 401);

        return $claims;
    }

    public function request(string $method, string $room, array $data = []): array
    {
        $grant = in_array($method, ['CreateRoom', 'DeleteRoom'], true) ? ['roomCreate' => true] : ($method === 'ListRooms' ? ['roomList' => true] : ['roomAdmin' => true, 'room' => $room]);
        $res = Http::timeout(5)->withToken($this->token(['video' => $grant]))->post(rtrim(config('calls.internal_url'), '/').'/twirp/livekit.RoomService/'.$method, $data ?: new \stdClass);
        if ($res->status() === 404 && in_array($method, ['DeleteRoom', 'RemoveParticipant'])) {
            return [];
        }
        abort_unless($res->successful(), 503, 'Media server is unavailable.');

        return $res->json() ?? [];
    }
}
