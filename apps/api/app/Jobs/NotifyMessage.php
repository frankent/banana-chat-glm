<?php

namespace App\Jobs;

use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Models\Device;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * FR-NOTI-002 — push fan-out for one message. Idempotent per
 * (message_id, device_id) via a Redis set with 1-day TTL (TC-NOTI-018).
 * Retries are safe: already-sent pairs are skipped.
 */
class NotifyMessage implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries = 5;

    public function __construct(
        public readonly string $messageId,
    ) {}

    public function handle(PushDecisionService $decision, FcmPushSender $sender): void
    {
        $message = Message::query()->with('mentions:id')->find($this->messageId);

        if ($message === null || $message->deleted_at !== null) {
            return;
        }

        $room = $message->room()->firstOrFail();
        $senderUser = $message->sender()->first();

        if ($senderUser === null) {
            return; // system messages never reach here (writer skips), belt+braces
        }

        $mentioned = $message->mentions->pluck('id')->all();
        $sentKey = "push:sent:{$message->id}";

        $members = RoomMember::query()
            ->where('room_id', $room->id)
            ->whereNull('left_at')
            ->where('user_id', '!=', $senderUser->id)
            ->with(['user.notificationSetting'])
            ->get();

        foreach ($members as $member) {
            $recipient = $member->user;

            if (! $decision->shouldNotify(
                $message, $room, $recipient, $senderUser->id,
                RoomNotificationSetting::query()->where('user_id', $recipient->id)->where('room_id', $room->id)->first(),
                $recipient->notificationSetting,
                $mentioned,
            )) {
                continue;
            }

            /** @var list<Device> $devices */
            $devices = Device::query()
                ->where('user_id', $recipient->id)
                ->whereNotNull('push_token')
                ->whereNull('push_disabled_at')
                ->get();

            if (count($devices) === 0) {
                continue;
            }

            // user is actively looking at this room → no push on any device (TC-NOTI-010)
            if ($decision->isFocusedOnRoom($devices, $room->id)) {
                continue;
            }

            $badge = $this->badge($recipient->id, $room->workspace_id);

            foreach ($devices as $device) {
                // idempotency: one push per message per device per day
                if (! Redis::connection()->sadd($sentKey, $device->id)) {
                    continue; // already sent (TC-NOTI-018)
                }
                Redis::connection()->expire($sentKey, 86_400);

                try {
                    $sender->send($device, $decision->payload($message, $room, $senderUser, $badge));
                } catch (Throwable $e) {
                    // drop this device from the set so the retry re-attempts it
                    Redis::connection()->srem($sentKey, $device->id);
                    report($e);
                }
            }
        }
    }

    /**
     * TC-NOTI-023 — unread total for the badge, muted rooms excluded.
     */
    private function badge(string $userId, string $workspaceId): int
    {
        $row = RoomMember::query()
            ->where('room_members.user_id', $userId)
            ->where('room_members.workspace_id', $workspaceId)
            ->whereNull('room_members.left_at')
            ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
            ->whereNull('rooms.deleted_at')
            ->whereColumn('room_members.last_read_seq', '<', 'rooms.last_user_seq')
            ->whereNotExists(function ($q) use ($userId): void {
                $q->selectRaw('1')
                    ->from('room_notification_settings')
                    ->whereColumn('room_notification_settings.room_id', 'room_members.room_id')
                    ->where('room_notification_settings.user_id', $userId)
                    ->where(function ($m): void {
                        $m->where('mode', 'none')->orWhere('muted_until', '>', now());
                    });
            })
            ->selectRaw('coalesce(sum(rooms.last_user_seq - room_members.last_read_seq), 0) as total')
            ->first();

        return (int) ($row->total ?? 0);
    }
}
