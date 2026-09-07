<?php

namespace App\Domain\Message;

use App\Enums\RoomRole;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * FR-MSG-008 — persist mentions for a message body.
 *
 * Only active members of the room are recorded (TC-MSG-050 — mentioning a
 * non-member is ignored, never an error). `@all` is owner/admin-only once
 * the room passes 20 members (TC-MSG-051) and expands to every active
 * member except the sender. Re-running on edit re-parses and re-syncs
 * (TC-MSG-053).
 */
class MentionSync
{
    public function __construct(
        private readonly MentionParser $parser,
    ) {}

    /**
     * @return list<string> user ids now mentioned by the message
     */
    public function sync(Message $message, Room $room, User $sender): array
    {
        if ($message->body === null || $message->body === '') {
            DB::table('message_mentions')->where('message_id', $message->id)->delete();

            return [];
        }

        [$usernames, $all] = $this->parser->parse($message->body);

        /** @var RoomMember|null $senderMembership */
        $senderMembership = RoomMember::query()
            ->where('room_id', $room->id)
            ->where('user_id', $sender->id)
            ->whereNull('left_at')
            ->first();

        $canAtAll = $senderMembership !== null
            && (
                in_array($senderMembership->role, [RoomRole::Owner, RoomRole::Admin], true)
                || $room->member_count <= 20
            );

        $query = User::query()
            ->join('room_members', 'room_members.user_id', '=', 'users.id')
            ->where('room_members.room_id', $room->id)
            ->whereNull('room_members.left_at')
            ->where('users.status', 'active')
            ->where('users.id', '!=', $sender->id);

        if ($all && $canAtAll) {
            // @all expands to the full active roster
            $ids = $query->pluck('users.id')->all();
        } else {
            if ($usernames === []) {
                DB::table('message_mentions')->where('message_id', $message->id)->delete();

                return [];
            }
            // citext column — IN() is already case-insensitive
            $ids = $query->whereIn('users.username', $usernames)->pluck('users.id')->all();
        }

        // (message_id, user_id) PK — sync() is idempotent on edit re-parse.
        // Removal goes through the pivot table directly: detach() ignores
        // whereNotIn on the relation builder and would wipe every row.
        DB::table('message_mentions')->upsert(
            array_map(fn (string $id) => [
                'message_id' => $message->id,
                'user_id' => $id,
                'workspace_id' => $room->workspace_id,
            ], array_values($ids)),
            ['message_id', 'user_id'],
            ['workspace_id'],
        );

        DB::table('message_mentions')
            ->where('message_id', $message->id)
            ->whereNotIn('user_id', $ids)
            ->delete();

        return array_values($ids);
    }
}
