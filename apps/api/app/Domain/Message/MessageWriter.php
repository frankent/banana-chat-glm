<?php

namespace App\Domain\Message;

use App\Enums\MessageType;
use App\Events\MessageCreated;
use App\Events\RoomActivity;
use App\Events\WorkspaceUnreadChanged;
use App\Exceptions\ApiException;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;

/**
 * D6 — the correctness-critical write path (FR-MSG-001):
 * lock room row → idempotency by (room_id, sender_id, client_message_id) →
 * seq = last_seq + 1 → insert → bump room counters → sender read pointer →
 * unhide → broadcast post-commit.
 *
 * @return array{0: Message, 1: bool} [message, created]
 */
class MessageWriter
{
    public function __construct(
        private readonly SettingsService $settings,
        private readonly MessageSerializer $serializer,
    ) {}

    public function write(Room $room, User $sender, ?string $body, ?string $clientMessageId, ?string $replyToMessageId = null): array
    {
        $body = $body !== null ? trim($body) : null;
        $body = $body === '' ? null : $body; // whitespace-only counts as empty (FR-MSG-001 edge)

        $maxLength = $this->settings->int('message.max_length');
        if ($body !== null && mb_strlen($body) > $maxLength) {
            throw ApiException::msgTooLong($maxLength);
        }

        if ($body === null) {
            throw ApiException::msgEmpty(); // attachments arrive in PH2
        }

        if ($replyToMessageId !== null) {
            $replyExists = Message::query()
                ->where('room_id', $room->id)
                ->whereKey($replyToMessageId)
                ->exists();

            if (! $replyExists) {
                throw ApiException::msgReplyInvalid();
            }
        }

        [$message, $created] = DB::transaction(function () use ($room, $sender, $body, $clientMessageId, $replyToMessageId): array {
            /** @var Room $locked */
            $locked = Room::query()
                ->whereKey($room->id)
                ->lockForUpdate()
                ->firstOrFail();

            // idempotent replay: same sender, room, client_message_id → 200 with the original
            if ($clientMessageId !== null) {
                $existing = Message::query()
                    ->where('room_id', $locked->id)
                    ->where('sender_id', $sender->id)
                    ->where('client_message_id', $clientMessageId)
                    ->first();

                if ($existing !== null) {
                    return [$existing, false];
                }
            }

            $seq = $locked->last_seq + 1;

            $message = Message::query()->create([
                'room_id' => $locked->id,
                'workspace_id' => $locked->workspace_id,
                'sender_id' => $sender->id,
                'seq' => $seq,
                'type' => MessageType::Text,
                'body' => $body,
                'client_message_id' => $clientMessageId,
                'reply_to_message_id' => $replyToMessageId,
            ]);

            $locked->forceFill([
                'last_seq' => $seq,
                'last_user_seq' => $seq,
                'last_message_id' => $message->id,
                'last_message_at' => now(),
            ])->save();

            // sender has trivially read their own message
            RoomMember::query()
                ->where('room_id', $locked->id)
                ->where('user_id', $sender->id)
                ->whereNull('left_at')
                ->update(['last_read_seq' => $seq, 'last_read_at' => now()]);

            // new message unhides the room for everyone (FR-ROOM-009)
            RoomMember::query()
                ->where('room_id', $locked->id)
                ->whereNotNull('hidden_at')
                ->update(['hidden_at' => null]);

            return [$message, true];
        });

        if ($created) {
            $this->fanOut($message);
        }

        return [$message, $created];
    }

    /**
     * Post-commit broadcasts: EVT-010 to the room, EVT-015/024 to each member
     * on private-user so lists/badges update even for unsubscribed rooms.
     */
    private function fanOut(Message $message): void
    {
        $room = $message->room()->firstOrFail();
        $payload = MessageSerializer::forEvent($message);

        broadcast(new MessageCreated($room, $payload));

        $members = RoomMember::query()
            ->where('room_id', $room->id)
            ->whereNull('left_at')
            ->get(['user_id', 'last_read_seq']);

        foreach ($members as $member) {
            $unread = max(0, $room->last_user_seq - $member->last_read_seq);

            broadcast(new RoomActivity($room, $member->user_id, $payload['body'], $unread));

            [$unreadRooms, $totalUnread] = $this->workspaceUnread($room->workspace_id, $member->user_id);
            broadcast(new WorkspaceUnreadChanged($room->workspace_id, $member->user_id, $unreadRooms, $totalUnread));
        }
    }

    /**
     * FR-READ-003 — muted (mode=none) rooms stay out of the workspace badge.
     *
     * @return array{0: int, 1: int} [unread_rooms_count, total_unread]
     */
    private function workspaceUnread(string $workspaceId, string $userId): array
    {
        $row = RoomMember::query()
            ->where('room_members.workspace_id', $workspaceId)
            ->where('room_members.user_id', $userId)
            ->whereNull('room_members.left_at')
            ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
            ->whereNull('rooms.deleted_at')
            ->whereColumn('room_members.last_read_seq', '<', 'rooms.last_user_seq')
            ->whereNotExists(function ($q) use ($userId): void {
                $q->selectRaw('1')
                    ->from('room_notification_settings')
                    ->whereColumn('room_notification_settings.room_id', 'room_members.room_id')
                    ->where('room_notification_settings.user_id', $userId)
                    ->where('room_notification_settings.mode', 'none');
            })
            ->selectRaw('count(*) as rooms, coalesce(sum(rooms.last_user_seq - room_members.last_read_seq), 0) as total')
            ->first();

        return [(int) $row->rooms, (int) $row->total];
    }
}
