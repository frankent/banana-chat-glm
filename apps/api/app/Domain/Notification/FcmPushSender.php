<?php

namespace App\Domain\Notification;

use App\Models\Device;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * FR-NOTI-002/003 — FCM HTTP v1 sender. With no server key configured the
 * send is a logged no-op (stub mode) so dev/CI run without credentials;
 * set FCM_SERVER_KEY to deliver for real. UNREGISTERED tokens delete the
 * row; other failures bump push_failed_count (disabled at 5).
 */
class FcmPushSender
{
    public const ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

    /**
     * @param  array{title: string, body: string, data: array<string, mixed>, collapse_key: string, badge: int}  $payload
     */
    public function send(Device $device, array $payload): void
    {
        $key = (string) config('services.fcm.server_key');

        if ($key === '') {
            Log::info('push.stub', ['device_id' => $device->id, 'title' => $payload['title']]);

            return;
        }

        $response = Http::withHeaders([
            'Authorization' => "key={$key}",
        ])->post(self::ENDPOINT, [
            'to' => $device->push_token,
            'collapse_key' => $payload['collapse_key'],
            'notification' => [
                'title' => $payload['title'],
                'body' => $payload['body'],
                'badge' => $payload['badge'],
            ],
            'data' => $payload['data'],
        ]);

        // FCM legacy API reports per-token errors inside a 200 body
        $errors = collect($response->json('results') ?? [])->pluck('error')->filter()->all();
        $ok = $response->successful() && $errors === [];

        if ($ok) {
            $device->forceFill(['push_failed_count' => 0, 'push_disabled_at' => null])->save();

            return;
        }

        if (in_array('UNREGISTERED', $errors, true) || str_contains((string) $response->body(), 'UNREGISTERED')) {
            $device->forceFill(['push_token' => null, 'push_provider' => null])->save(); // TC-NOTI-016

            return;
        }

        $count = $device->push_failed_count + 1;
        $device->forceFill([
            'push_failed_count' => $count,
            'push_disabled_at' => $count >= 5 ? now() : null, // TC-NOTI-017
        ])->save();

        throw new \RuntimeException("fcm send failed: {$response->status()}");
    }
}
