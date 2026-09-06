<?php

namespace App\Domain\Room;

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
        return DB::transaction(function () use ($room, $actor, $event, $context): Message {
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
    }
}
