<?php

namespace App\Domain\Room;

use App\Domain\Message\MessageWriter;
use App\Enums\MessageType;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * System messages (member_added, room_renamed, ...) — seq comes from the same
 * room lock discipline as MessageWriter (D6) so user + system writes share one
 * monotonic sequence.
 */
class SystemMessageWriter
{
    public function write(Room $room, User $actor, string $event, array $context = []): Message
    {
        $message = DB::transaction(function () use ($room, $actor, $event, $context): Message {
            /** @var Room $locked */
            $locked = Room::query()
                ->whereKey($room->id)
                ->lockForUpdate()
                ->firstOrFail();

            $seq = $locked->last_seq + 1;

            $message = Message::query()->create([
                'room_id' => $locked->id,
                'workspace_id' => $locked->workspace_id,
                'sender_id' => $actor->id,
                'seq' => $seq,
                'type' => MessageType::System,
                'body' => null,
                'system_event' => ['event' => $event, ...$context],
            ]);

            $locked->forceFill([
                'last_seq' => $seq,
                'last_message_id' => $message->id,
                'last_message_at' => now(),
            ])->save();

            // actor has trivially "read" their own action
            RoomMember::query()
                ->where('room_id', $locked->id)
                ->where('user_id', $actor->id)
                ->whereNull('left_at')
                ->update(['last_read_seq' => $seq, 'last_read_at' => now()]);

            return $message;
        });

        // DEC-091 — system rows reach open timelines and room lists live, like
        // user messages; after commit so a caller's outer transaction (e.g.
        // CallService::start) never announces a row that rolls back. No push:
        // MessageWriter never dispatches NotifyMessage for system rows.
        DB::afterCommit(fn () => app(MessageWriter::class)->fanOut($message));

        return $message;
    }

    /**
     * DEC-097 — `member_added` names the people it added, snapshotted at write
     * time (id + display name only, never a URL) so the timeline can say who
     * without a lookup per row.
     *
     * @param  iterable<User>  $users
     * @return list<array{id: string, display_name: string}>
     */
    public static function memberStubs(iterable $users): array
    {
        $stubs = [];
        foreach ($users as $user) {
            $stubs[] = ['id' => $user->id, 'display_name' => $user->display_name];
        }

        return $stubs;
    }

    /**
     * Room-list preview for a system row — shared by the list (API-020) and
     * the realtime room.activity so both say the same thing.
     */
    public static function preview(Message $message): string
    {
        $event = $message->system_event ?? [];

        return match ($event['event'] ?? null) {
            'call_started' => ($event['kind'] ?? 'video') === 'voice' ? '📞 เริ่มโทรด้วยเสียง' : '📹 เริ่มวิดีโอคอล',
            'room_avatar_changed' => '🖼️ เปลี่ยนรูปกลุ่ม',
            'room_renamed' => 'เปลี่ยนชื่อกลุ่มเป็น '.($event['name'] ?? ''),
            default => '',
        };
    }
}
