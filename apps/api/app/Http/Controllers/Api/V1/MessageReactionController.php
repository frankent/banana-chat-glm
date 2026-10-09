<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\AvatarUrls;
use App\Domain\Message\MessageReactions;
use App\Domain\Room\RoomPolicy;
use App\Enums\MessageType;
use App\Events\MessageReactionsChanged;
use App\Exceptions\ApiException;
use App\Models\Message;
use App\Models\Room;
use App\Models\User;
use App\Support\ReactionEmoji;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * FR-MSG-012 / DEC-098 — API-237..239. One reaction per user per message:
 * a new emoji replaces the old one. Writes serialise on the message row.
 */
class MessageReactionController
{
    public const MAX_DISTINCT = 20;

    public const USERS_PER_EMOJI = 100;

    public function __construct(private readonly RoomPolicy $policy) {}

    /** API-237 */
    public function put(Request $request, string $roomId, string $messageId): JsonResponse
    {
        $emoji = ReactionEmoji::normalize($request->input('emoji')) ?? throw ApiException::reactionInvalid();

        return $this->mutate($request, $roomId, $messageId, $emoji);
    }

    /** API-238 */
    public function destroy(Request $request, string $roomId, string $messageId): JsonResponse
    {
        return $this->mutate($request, $roomId, $messageId, null);
    }

    /** API-239 */
    public function index(Request $request, string $roomId, string $messageId): JsonResponse
    {
        $room = $this->room($request, $roomId);
        Message::where('room_id', $room->id)->whereNull('deleted_at')->findOrFail($messageId);

        $summary = MessageReactions::forMessage($messageId, null)['reactions'];

        $sub = DB::table('message_reactions as mr')
            ->join('users as u', 'u.id', '=', 'mr.user_id')
            ->where('mr.message_id', $messageId)
            ->selectRaw('mr.emoji, u.id as user_id, u.display_name, row_number() over (partition by mr.emoji order by u.display_name, u.id) as rn');
        $rows = DB::query()->fromSub($sub, 't')
            ->where('rn', '<=', self::USERS_PER_EMOJI)
            ->orderBy('display_name')->orderBy('user_id')
            ->get();

        $users = User::with('avatarAttachment')->whereIn('id', $rows->pluck('user_id')->unique())->get()->keyBy('id');
        $byEmoji = [];
        foreach ($rows as $row) {
            $u = $users->get($row->user_id);
            if ($u === null) {
                continue;
            }
            $byEmoji[$row->emoji][] = [
                'id' => $u->id,
                'username' => $u->username,
                'display_name' => $u->display_name,
                'avatar_attachment_id' => $u->avatar_attachment_id,
                'avatar' => AvatarUrls::for($u->avatarAttachment),
            ];
        }

        return response()->json(['data' => [
            'message_id' => $messageId,
            'reactions' => array_map(
                fn (array $r) => $r + ['users' => $byEmoji[$r['emoji']] ?? []],
                $summary,
            ),
        ]]);
    }

    private function room(Request $request, string $roomId): Room
    {
        $room = Room::whereNull('deleted_at')->findOrFail($roomId);
        $this->policy->membershipOrFail($room, $request->user()); // 403 not member, 410 expired secret room

        return $room;
    }

    private function mutate(Request $request, string $roomId, string $messageId, ?string $emoji): JsonResponse
    {
        $room = $this->room($request, $roomId);
        $userId = $request->user()->id;

        // The snapshot is read while the message row lock is still held, so the
        // broadcast counts and the actor's emoji always describe the same instant.
        [$changed, $state] = DB::transaction(function () use ($room, $messageId, $userId, $emoji): array {
            $message = Message::where('room_id', $room->id)->whereNull('deleted_at')->lockForUpdate()->findOrFail($messageId);
            if ($message->type === MessageType::System) {
                throw ApiException::reactionInvalid();
            }

            $mine = DB::table('message_reactions')->where('message_id', $messageId)->where('user_id', $userId);
            $current = (clone $mine)->pluck('emoji')->all();
            if ($current === ($emoji === null ? [] : [$emoji])) {
                return [false, MessageReactions::forMessage($messageId, $userId)]; // idempotent no-op
            }

            $mine->delete();
            if ($emoji !== null) {
                $taken = DB::table('message_reactions')->where('message_id', $messageId)->distinct()->pluck('emoji');
                if (! $taken->contains($emoji) && $taken->count() >= self::MAX_DISTINCT) {
                    throw ApiException::reactionLimit(self::MAX_DISTINCT);
                }
                DB::table('message_reactions')->insertOrIgnore(['message_id' => $messageId, 'user_id' => $userId, 'emoji' => $emoji]);
            }

            return [true, MessageReactions::forMessage($messageId, $userId)];
        });

        if ($changed) {
            broadcast(new MessageReactionsChanged($room, $messageId, $state['reactions'], $userId, $state['my_reaction']));
        }

        return response()->json(['data' => ['message_id' => $messageId] + $state]);
    }
}
