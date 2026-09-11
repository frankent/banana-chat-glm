<?php

namespace App\Domain\Calls;

use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Illuminate\Support\Facades\Http;

/** FR-CALL-004: grant signing stays server-side; never log tokens. */
class MediaServer
{
    public function token(array $claims): string
    {
        return JWT::encode(array_merge(['iss' => config('calls.key'), 'nbf' => time() - 5, 'exp' => time() + 60], $claims), config('calls.secret'), 'HS256');
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
