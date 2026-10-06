<?php

namespace App\Domain\Notification;

use App\Models\Device;
use App\Models\RoomCall;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Throwable;

/**
 * FR-NOTI-010 / DEC-095 — closed-app ringing for a 1-to-1 call.
 *
 * Two phases share one collapse key / web tag (`call-{id}`), so the "missed
 * call" notification REPLACES the ringing one on the device instead of leaving
 * a stale "Incoming call" behind:
 *   ring   — repeated every RING_INTERVAL seconds for the RING_WINDOW (the same
 *            60 s a call can ring, FR-CALL-002/canRingCall); each repeat
 *            re-alerts (renotify) because a web push cannot loop a ringtone.
 *   missed — one quiet replacement when the call ended without an answer.
 *
 * Recipient-side privacy (DEC-076/087): masked title/body when the RECIPIENT
 * has privacy_mode on. Caller avatar is never sent (DEC-087).
 */
class CallPush
{
    public const RING_INTERVAL = 10;

    public const RING_WINDOW = 60;

    public function __construct(private FcmPushSender $sender, private PrivacyMasker $masker) {}

    /**
     * @return array{title: string, body: string, data: array<string, string>, collapse_key: string}
     */
    public function payload(RoomCall $call, User $caller, User $recipient, string $phase): array
    {
        $setting = $recipient->notificationSetting;
        $masked = $this->masker->enabled($setting?->privacy_mode);

        return [
            'title' => $masked ? $this->masker->title() : (string) $caller->display_name,
            'body' => $this->masker->body($phase === 'missed' ? 'missed_call' : 'call', $recipient->locale),
            'data' => [
                'type' => $phase === 'missed' ? 'call_missed' : 'call',
                'call_id' => (string) $call->id,
                'room_id' => (string) $call->room_id,
                'workspace_id' => (string) $call->workspace_id,
                'kind' => (string) $call->kind,
            ],
            'collapse_key' => 'call-'.$call->id,
        ];
    }

    /**
     * Push one phase to every registered device of the recipient. Returns the
     * number of devices that hold a token (0 = nobody opted in, so the caller
     * can stop its ring loop). Per-device failures are reported, never thrown:
     * one dead token must not stop the others or burn the retry budget.
     */
    public function deliver(RoomCall $call, User $recipient, string $phase, int $tick = 0): int
    {
        $devices = Device::query()
            ->where('user_id', $recipient->id)
            ->whereNotNull('push_token')
            ->whereNull('push_disabled_at')
            ->get();

        if ($devices->isEmpty()) {
            return 0;
        }

        $caller = User::query()->find($call->started_by);
        if ($caller === null) {
            return 0;
        }

        $payload = $this->payload($call, $caller, $recipient, $phase);

        /** @var Device $device */
        foreach ($devices as $device) {
            // a job retry must not ring the same device twice for the same tick
            if (! Cache::add("push:call:{$call->id}:{$phase}:{$tick}:{$device->id}", 1, 300)) {
                continue;
            }
            try {
                $this->sender->send($device, $payload);
            } catch (Throwable $e) {
                Cache::forget("push:call:{$call->id}:{$phase}:{$tick}:{$device->id}");
                report($e);
            }
        }

        return $devices->count();
    }

    public static function ringKey(string $callId, string $userId): string
    {
        return "call:ring-pushed:{$callId}:{$userId}";
    }
}
