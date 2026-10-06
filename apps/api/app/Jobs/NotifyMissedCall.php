<?php

namespace App\Jobs;

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
 * FR-NOTI-010 / DEC-095 — replaces the ringing notification (same tag) with a
 * quiet "missed call" once a 1-to-1 call ended unanswered. Sent only to a
 * recipient who was actually pushed a ring and never joined, so a muted/DND
 * user or one who answered never sees it. Dispatched with a short delay so an
 * in-flight ring tick cannot land after it.
 */
class NotifyMissedCall implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;

    public int $tries = 3;

    public function __construct(public readonly string $callId, public readonly string $recipientId) {}

    public function handle(CallPush $push): void
    {
        $call = RoomCall::query()->find($this->callId);

        if ($call === null || $call->ended_at === null || $call->connected_at !== null
            || ! Cache::has(CallPush::ringKey($call->id, $this->recipientId))
            || CallParticipant::query()->where('call_id', $call->id)->where('user_id', $this->recipientId)->exists()
            || ! Cache::add("call:missed-pushed:{$call->id}:{$this->recipientId}", 1, 600)) {
            return;
        }

        $recipient = User::query()->with('notificationSetting')->find($this->recipientId);
        if ($recipient !== null) {
            $push->deliver($call, $recipient, 'missed');
        }
    }
}
