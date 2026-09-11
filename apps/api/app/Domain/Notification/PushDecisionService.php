<?php

namespace App\Domain\Notification;

use App\Enums\MessageType;
use App\Enums\NotificationMode;
use App\Enums\RoomType;
use App\Enums\UserStatus;
use App\Models\Device;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Services\SettingsService;
use Illuminate\Support\Carbon;

/**
 * FR-NOTI-002 — one place that answers "does this user get a push for this
 * message?" and builds the payload. Pure decision logic, unit-testable
 * (TC-NOTI-005..015, TC-NOTI-023/024).
 */
class PushDecisionService
{
    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * @param  list<string>  $mentionedUserIds
     */
    public function shouldNotify(
        Message $message,
        Room $room,
        User $recipient,
        string $senderId,
        ?RoomNotificationSetting $roomSetting,
        ?UserNotificationSetting $userSetting,
        array $mentionedUserIds,
    ): bool {
        if ($message->type === MessageType::System) {
            return false; // TC-NOTI-011 (job not even dispatched)
        }

        if ($recipient->id === $senderId) {
            return false; // TC-NOTI-005
        }

        if ($recipient->status !== UserStatus::Active) {
            return false; // TC-NOTI-024
        }

        // room-level: muted window / mode (TC-NOTI-006/007/008)
        if ($roomSetting !== null) {
            if ($roomSetting->mode === NotificationMode::None) {
                return false;
            }

            if ($roomSetting->muted_until !== null && $roomSetting->muted_until->isFuture()) {
                return false;
            }

            if ($roomSetting->mode === NotificationMode::Mentions && ! in_array($recipient->id, $mentionedUserIds, true)) {
                return false;
            }
        }

        // user-level DND in the recipient's timezone (TC-NOTI-009)
        if ($this->inDnd($userSetting, $recipient->timezone)) {
            return false;
        }

        return true;
    }

    /**
     * TC-NOTI-010 — any device focused on this room within the suppression
     * window silences every device of that user.
     *
     * @param  iterable<Device>  $devices
     */
    public function isFocusedOnRoom(iterable $devices, string $roomId): bool
    {
        $window = $this->settings->int('push.suppress_if_focused_seconds');

        foreach ($devices as $device) {
            if ($device->focused_room_id === $roomId
                && $device->focused_at !== null
                && $device->focused_at->diffInSeconds(now()) <= $window) {
                return true;
            }
        }

        return false;
    }

    /**
     * FR-NOTI-002 payload: dm → sender name + raw body; group → room name +
     * "sender: body"; body clipped at 120; preview_in_push=false →
     * "ข้อความใหม่"; media-only → emoji badge (TC-NOTI-012..015).
     *
     * @param  array{unread_rooms_count?: int, total_unread?: int}  $badge
     * @return array{title: string, body: string, data: array<string, mixed>, collapse_key: string, badge: int}
     */
    public function payload(Message $message, Room $room, User $sender, int $badge): array
    {
        $previewInPush = $sender->notificationSetting?->preview_in_push ?? true;

        $title = $room->type === RoomType::Dm
            ? $sender->display_name
            : $room->name ?? 'ห้องแชท';

        if (! $previewInPush) {
            $textBody = 'ข้อความใหม่'; // TC-NOTI-014
        } elseif ($message->body !== null && $message->body !== '') {
            $textBody = mb_substr($message->body, 0, 120);
        } else {
            $textBody = match ($message->type) { // TC-NOTI-015
                MessageType::Image => '📷 รูปภาพ',
                MessageType::Video => '🎬 วิดีโอ',
                default => '📎 ไฟล์แนบ',
            };
        }

        return [
            'title' => $title,
            'body' => $room->type === RoomType::Dm ? $textBody : "{$sender->display_name}: {$textBody}",
            'data' => [
                'room_id' => $room->id,
                'workspace_id' => $room->workspace_id,
                'message_id' => $message->id,
                'seq' => (int) $message->seq,
            ],
            'collapse_key' => $room->id,
            'badge' => $badge, // TC-NOTI-023: caller computes unread minus muted
        ];
    }

    /**
     * DND window in the user's timezone; supports ranges crossing midnight
     * (TC-NOTI-009). dnd_days = ISO day numbers (1=Mon .. 7=Sun) or null = every day.
     */
    public function inDnd(?UserNotificationSetting $setting, ?string $timezone): bool
    {
        if ($setting === null || $setting->dnd_start === null || $setting->dnd_end === null) {
            return false;
        }

        $now = Carbon::now($timezone ?? 'UTC');
        $start = Carbon::parse($setting->dnd_start, $timezone ?? 'UTC')->setDateFrom($now);
        $end = Carbon::parse($setting->dnd_end, $timezone ?? 'UTC')->setDateFrom($now);

        $days = $setting->dnd_days !== null ? array_map('intval', $setting->dnd_days) : null;
        $today = $now->dayOfWeekIso;
        $yesterday = $today === 1 ? 7 : $today - 1;

        // does today's window (or yesterday's, spilling over midnight) cover now?
        $inToday = $days === null || in_array($today, $days, true);
        $inYesterday = $days === null || in_array($yesterday, $days, true);

        if ($start->lte($end)) {
            return $inToday && $now->between($start, $end, false);
        }

        // overnight: [start, midnight) from yesterday/today + [midnight, end) today
        $lateWindow = $now->gte($start) && $now->lt($end->copy()->addDay());
        $earlyWindow = $now->lt($end);

        return ($inToday && $lateWindow) || ($inYesterday && $earlyWindow);
    }
}
