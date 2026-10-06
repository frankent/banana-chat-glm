<?php

namespace App\Jobs;

use App\Domain\Calls\CallService;
use App\Domain\Notification\CallPush;
use App\Models\CallParticipant;
use App\Models\RoomCall;
use App\Models\User;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\Cache;

/**
 * FR-NOTI-010 / DEC-095 — one ring tick of the closed-app call push. Re-queues
 * itself every CallPush::RING_INTERVAL seconds while the call is still
 * ringing: not ended, not connected, the recipient has not joined, inside the
 * 60 s ring window. Decline/cancel/timeout all end the call, so the loop
 * stops by itself.
 */
class NotifyIncomingCall implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;

    public int $tries = 3;

    public function __construct(public readonly string $callId, public readonly string $recipientId, public readonly int $tick = 0) {}

    public function handle(CallPush $push, CallService $calls): void
    {
        $call = RoomCall::query()->find($this->callId);

        if ($call === null || $call->ended_at !== null || $call->connected_at !== null
            || $call->created_at->lt(now()->subSeconds(CallPush::RING_WINDOW))
            || CallParticipant::query()->where('call_id', $call->id)->where('user_id', $this->recipientId)->exists()
            || ! $calls->allowed($this->recipientId, $call->room_id)) {
            return;
        }

        $recipient = User::query()->with('notificationSetting')->find($this->recipientId);
        if ($recipient === null) {
            return;
        }

        if ($push->deliver($call, $recipient, 'ring', $this->tick) === 0) {
            return; // no device opted in to push: nothing to repeat
        }
        Cache::put(CallPush::ringKey($call->id, $recipient->id), 1, 600);

        if (($this->tick + 1) * CallPush::RING_INTERVAL < CallPush::RING_WINDOW) {
            self::dispatch($this->callId, $this->recipientId, $this->tick + 1)
                ->delay(now()->addSeconds(CallPush::RING_INTERVAL));
        }
    }
}
