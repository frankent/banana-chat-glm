<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Message\MessageSerializer;
use App\Enums\RoomType;
use App\Http\Controllers\Controller;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Support\WorkspaceContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * API-080/081 — message + file search (FR-SRCH-001/002).
 *
 * Thai match runs through pg_trgm ILIKE (no word boundaries for FTS —
 * DEC-010); English also hits the messages.body_search tsvector generated
 * column. Only rooms the caller belongs to are searched; deleted rooms and
 * deleted messages never match.
 */
class SearchController extends Controller
{
    private const int LIMIT = 25;

    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly MessageSerializer $serializer,
    ) {}

    /**
     * API-080 — GET /search/messages.
     */
    public function messages(Request $request): JsonResponse
    {
        $ws = $this->context->workspace();

        $data = $request->validate([
            'q' => ['required', 'string', 'min:2', 'max:200'], // TC-SRCH-006
            'room_id' => ['nullable', 'ulid'],
            'sender_id' => ['nullable', 'ulid'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'type' => ['nullable', 'string', 'in:text,image,video,file'],
            'cursor' => ['nullable', 'string'],
        ]);

        $q = trim((string) $data['q']);
        $like = '%'.str_replace(['%', '_', '\\'], ['\\%', '\\_', '\\\\'], $q).'%';

        $query = Message::query()
            ->where('messages.workspace_id', $ws->id)
            ->whereNull('messages.deleted_at')
            ->whereNotNull('messages.body')
            ->whereIn('messages.room_id', $this->memberRoomIds($request->user()->id))
            ->where(function ($sub) use ($like, $q) {
                $sub->whereRaw("body_search @@ plainto_tsquery('simple', ?)", [$q])
                    ->orWhere('messages.body', 'ILIKE', $like);
            })
            ->with(['sender:id,username,display_name,avatar_attachment_id', 'attachments'])
            ->orderByDesc('messages.created_at')
            ->orderByDesc('messages.id');

        $this->applyMessageFilters($query, $data);
        $this->applyCursor($query, $data['cursor'] ?? null, 'messages.created_at', 'messages.id');

        $rows = $query->take(self::LIMIT + 1)->get();

        $next = null;
        if ($rows->count() > self::LIMIT) {
            $last = $rows[self::LIMIT - 1];
            $next = $last->created_at->toIso8601String().'|'.$last->id;
            $rows = $rows->take(self::LIMIT);
        }

        $rooms = Room::query()
            ->whereIn('id', $rows->pluck('room_id')->unique())
            ->get()
            ->keyBy('id');

        return response()->json([
            'data' => [
                'results' => $rows->map(fn (Message $m) => [
                    'message' => $this->serializer->toArray($m),
                    'room' => $this->roomSummary($rooms->get($m->room_id)),
                    'highlight' => $this->highlight((string) $m->body, $q),
                ])->values()->all(),
                'next_cursor' => $next,
            ],
        ]);
    }

    /**
     * API-081 — GET /search/files (original_name match; FR-SRCH-002).
     */
    public function files(Request $request): JsonResponse
    {
        $ws = $this->context->workspace();

        $data = $request->validate([
            'q' => ['required', 'string', 'min:1', 'max:200'],
            'kind' => ['nullable', 'string', 'in:image,video,file'],
            'room_id' => ['nullable', 'ulid'],
            'cursor' => ['nullable', 'string'],
        ]);

        $q = trim((string) $data['q']);
        $like = '%'.str_replace(['%', '_', '\\'], ['\\%', '\\_', '\\\\'], $q).'%';

        $query = DB::table('attachments')
            ->join('message_attachments', 'message_attachments.attachment_id', '=', 'attachments.id')
            ->join('messages', 'messages.id', '=', 'message_attachments.message_id')
            ->where('attachments.workspace_id', $ws->id)
            ->whereNull('attachments.deleted_at')
            ->where('attachments.status', 'ready')
            ->whereNull('messages.deleted_at') // TC-SRCH-011
            ->whereIn('messages.room_id', $this->memberRoomIds($request->user()->id))
            ->where('attachments.original_name', 'ILIKE', $like)
            ->when(isset($data['kind']), fn ($sub) => $sub->where('attachments.kind', $data['kind']))
            ->when(isset($data['room_id']), fn ($sub) => $sub->where('messages.room_id', $data['room_id']))
            ->select('attachments.*', 'messages.room_id as pivot_room_id', 'messages.id as pivot_message_id',
                'messages.sender_id as pivot_sender_id', 'messages.seq as pivot_seq',
                'messages.body as pivot_body', 'messages.created_at as pivot_message_at')
            ->orderByDesc('messages.created_at')
            ->orderByDesc('attachments.id');

        $this->applyCursor($query, $data['cursor'] ?? null, 'messages.created_at', 'attachments.id');

        $rows = $query->take(self::LIMIT + 1)->get();

        $next = null;
        if (count($rows) > self::LIMIT) {
            $last = $rows[self::LIMIT - 1];
            $next = $last->pivot_message_at.'|'.$last->id;
            $rows = array_slice($rows, 0, self::LIMIT);
        }

        $rooms = Room::query()
            ->whereIn('id', collect($rows)->pluck('pivot_room_id')->filter()->unique()->all())
            ->get()
            ->keyBy('id');

        return response()->json([
            'data' => [
                'results' => collect($rows)->map(function ($row) use ($rooms) {
                    return [
                        'attachment' => [
                            'id' => $row->id,
                            'message_id' => $row->pivot_message_id,
                            'kind' => $row->kind,
                            'original_name' => $row->original_name,
                            'mime_type' => $row->mime_type,
                            'size_bytes' => (int) $row->size_bytes,
                            'width' => $row->width !== null ? (int) $row->width : null,
                            'height' => $row->height !== null ? (int) $row->height : null,
                            'created_at' => $row->created_at,
                        ],
                        'message' => [
                            'id' => $row->pivot_message_id,
                            'room_id' => $row->pivot_room_id,
                            'sender_id' => $row->pivot_sender_id,
                            'seq' => (int) $row->pivot_seq,
                            'body' => $row->pivot_body,
                            'created_at' => $row->pivot_message_at,
                        ],
                        'room' => $this->roomSummary($rooms->get($row->pivot_room_id)),
                    ];
                })->values()->all(),
                'next_cursor' => $next,
            ],
        ]);
    }

    /**
     * @return Builder<RoomMember>
     */
    private function memberRoomIds(string $userId)
    {
        return RoomMember::query()
            ->join('rooms', 'rooms.id', '=', 'room_members.room_id')
            ->where('room_members.user_id', $userId)
            ->whereNull('room_members.left_at')
            ->whereNull('rooms.deleted_at') // TC-SRCH-003
            ->select('room_members.room_id');
    }

    private function applyMessageFilters($query, array $data): void
    {
        if (isset($data['room_id'])) {
            $query->where('messages.room_id', $data['room_id']);
        }
        if (isset($data['sender_id'])) {
            $query->where('messages.sender_id', $data['sender_id']);
        }
        if (isset($data['from'])) {
            $query->where('messages.created_at', '>=', $data['from']);
        }
        if (isset($data['to'])) {
            $query->where('messages.created_at', '<=', $data['to']);
        }
        if (isset($data['type'])) {
            $query->where('messages.type', $data['type']);
        }
    }

    private function applyCursor($query, ?string $cursor, string $atColumn, string $idColumn): void
    {
        if (! is_string($cursor) || $cursor === '') {
            return;
        }
        [$at, $id] = explode('|', $cursor, 2) + [null, null];
        if ($at === null) {
            return;
        }
        $query->where(function ($sub) use ($at, $id, $atColumn, $idColumn) {
            $sub->where($atColumn, '<', $at)
                ->orWhere(fn ($s2) => $s2->where($atColumn, $at)->where($idColumn, '<', $id ?? ''));
        });
    }

    /**
     * TC-SRCH-005 — escape FIRST, then wrap matches: the inserted <mark> tags
     * are the only raw HTML in the output.
     */
    private function highlight(string $body, string $q): string
    {
        $escaped = htmlspecialchars($body, ENT_QUOTES, 'UTF-8');
        if ($q === '') {
            return $escaped;
        }
        $needle = htmlspecialchars($q, ENT_QUOTES, 'UTF-8');

        return (string) preg_replace_callback(
            '/'.preg_quote($needle, '/').'/iu',
            fn (array $m) => '<mark>'.$m[0].'</mark>',
            $escaped,
        ) ?? $escaped;
    }

    private function roomSummary(?Room $room): ?array
    {
        if ($room === null) {
            return null;
        }
        $type = $room->type instanceof RoomType ? $room->type->value : $room->type;

        return [
            'id' => $room->id,
            'workspace_id' => $room->workspace_id,
            'type' => $type,
            'name' => $room->name,
        ];
    }
}
