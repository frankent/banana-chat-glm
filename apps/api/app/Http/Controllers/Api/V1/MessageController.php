<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Message\MessageSerializer;
use App\Domain\Message\MessageWriter;
use App\Domain\Room\RoomPolicy;
use App\Events\RoomRead;
use App\Events\WorkspaceUnreadChanged;
use App\Http\Controllers\Controller;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * API-040/041/045/046 — messages, read pointer, read status
 * (FR-MSG-001/003/009, FR-READ-001/002).
 */
class MessageController extends Controller
{
    public function __construct(
        private readonly RoomPolicy $policy,
        private readonly MessageWriter $writer,
        private readonly MessageSerializer $serializer,
    ) {}

    /**
     * API-041 — history by seq cursor (FR-MSG-003).
     */
    public function index(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $this->policy->membershipOrFail($room, $request->user());

        $data = $request->validate([
            'before_seq' => ['nullable', 'integer', 'min:1'],
            'after_seq' => ['nullable', 'integer', 'min:0'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $limit = (int) ($data['limit'] ?? 50);
        $before = isset($data['before_seq']) ? (int) $data['before_seq'] : null;
        $after = isset($data['after_seq']) ? (int) $data['after_seq'] : null;

        $query = Message::query()
            ->where('room_id', $room->id)
            ->with([
                'sender:id,username,display_name,avatar_attachment_id',
                'replyTo:id,room_id,sender_id,body,deleted_at',
            ]);

        if ($after !== null) {
            // gap-fill / catch-up: ascending from the cursor
            $messages = $query->where('seq', '>', $after)
                ->orderBy('seq')
                ->limit($limit + 1)
                ->get();
            $hasMoreAfter = $messages->count() > $limit;
            $messages = $messages->take($limit);
            $hasMoreBefore = $messages->isNotEmpty()
                && Message::query()->where('room_id', $room->id)->where('seq', '<', $messages->first()->seq)->exists();
        } else {
            // default: latest page, ascending output
            $messages = collect();
            if ($before !== null) {
                $query->where('seq', '<', $before);
            }

            $latest = $query->orderByDesc('seq')->limit($limit + 1)->get();
            $hasMoreBefore = $latest->count() > $limit;
            $messages = $latest->take($limit)->reverse()->values();
            $hasMoreAfter = $messages->isNotEmpty()
                && Message::query()->where('room_id', $room->id)->where('seq', '>', $messages->last()->seq)->exists();
        }

        return response()->json([
            'data' => [
                'messages' => $messages->map(fn (Message $m) => $this->serializer->toArray($m))->values(),
                'has_more_before' => $hasMoreBefore,
                'has_more_after' => $hasMoreAfter,
            ],
        ]);
    }

    /**
     * API-040 — send (201 new / 200 idempotent replay, FR-MSG-001).
     */
    public function store(Request $request, string $roomId): JsonResponse
    {
        $data = $request->validate([
            'client_message_id' => ['required', 'uuid'],
            'body' => ['nullable', 'string'],
            'reply_to_message_id' => ['nullable', 'ulid'],
        ]);

        $room = $this->roomOrFail($roomId);

        /** @var User $user */
        $user = $request->user();
        $this->policy->membershipOrFail($room, $user); // left/removed → 403 ROOM_NOT_MEMBER

        [$message, $created] = $this->writer->write(
            $room,
            $user,
            $data['body'] ?? null,
            $data['client_message_id'],
            $data['reply_to_message_id'] ?? null,
        );

        $message->loadMissing([
            'sender:id,username,display_name,avatar_attachment_id',
            'replyTo:id,room_id,sender_id,body,deleted_at',
        ]);

        return response()->json([
            'data' => ['message' => $this->serializer->toArray($message)],
        ], $created ? 201 : 200);
    }

    /**
     * API-045 — mark as read: monotonic, clamped to last_seq (FR-READ-001).
     */
    public function markRead(Request $request, string $roomId): JsonResponse
    {
        $data = $request->validate([
            'seq' => ['required', 'integer', 'min:0'],
        ]);

        $room = $this->roomOrFail($roomId);

        /** @var User $user */
        $user = $request->user();
        $membership = $this->policy->membershipOrFail($room, $user);

        $requested = min((int) $data['seq'], (int) $room->last_seq); // clamp

        $changed = false;
        if ($requested > $membership->last_read_seq) {
            DB::transaction(function () use ($membership, $requested, &$changed): void {
                RoomMember::query()
                    ->where('id', $membership->id)
                    ->where('last_read_seq', '<', $requested) // monotonic guard under concurrency
                    ->update(['last_read_seq' => $requested, 'last_read_at' => now()]);
                $changed = true;
            });
        }

        if ($changed) {
            broadcast(new RoomRead($room, $user->id, $requested));

            [$unreadRooms, $totalUnread] = $this->workspaceUnread($room->workspace_id, $user->id);
            broadcast(new WorkspaceUnreadChanged($room->workspace_id, $user->id, $unreadRooms, $totalUnread));
        }

        return response()->json(['data' => ['last_read_seq' => max($requested, $membership->last_read_seq)]]);
    }

    /**
     * API-046 — who has read up to a seq (FR-READ-002).
     */
    public function readStatus(Request $request, string $roomId): JsonResponse
    {
        $room = $this->roomOrFail($roomId);
        $this->policy->membershipOrFail($room, $request->user());

        $seq = (int) $request->query('seq', $room->last_seq);

        $rows = RoomMember::query()
            ->where('room_id', $room->id)
            ->whereNull('left_at')
            ->where('last_read_seq', '>=', $seq)
            ->join('users', 'users.id', '=', 'room_members.user_id')
            ->orderBy('users.display_name')
            ->get([
                'users.id as user_id', 'users.username', 'users.display_name', 'users.avatar_attachment_id',
                'room_members.last_read_seq', 'room_members.last_read_at',
            ]);

        return response()->json([
            'data' => [
                'seq' => $seq,
                'read_by' => $rows->map(fn ($r) => [
                    'user_id' => $r->user_id,
                    'username' => $r->username,
                    'display_name' => $r->display_name,
                    'avatar_attachment_id' => $r->avatar_attachment_id,
                    'last_read_seq' => (int) $r->last_read_seq,
                    'last_read_at' => $r->last_read_at !== null
                        ? Carbon::parse($r->last_read_at)->toIso8601String()
                        : null,
                ])->values(),
            ],
        ]);
    }

    /**
     * Same resolution rules as RoomController — context-scoped + alive only.
     */
    private function roomOrFail(string $roomId): Room
    {
        return Room::query()
            ->whereNull('deleted_at')
            ->findOrFail($roomId);
    }

    /**
     * @return array{0: int, 1: int}
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
