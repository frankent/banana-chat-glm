<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\UploadService;
use App\Domain\PublicChat\PublicChatGate;
use App\Domain\PublicChat\PublicChatMessageWriter;
use App\Domain\PublicChat\PublicChatService;
use App\Domain\PublicChat\PublicChatStaffSerializer;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatTyping;
use App\Events\PublicChatTypingStaff;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRead;
use App\Models\PublicChatRoom;
use App\Services\AuditLogger;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * TIER 3 — FR-PCHAT-004/005/006/009/010/021 · API-220..228.
 * Inside ['auth:api','account.active','password.fresh','workspace.context'].
 *
 * ==== AUTHORISATION IS DECISION A, AND IT IS THE WHOLE STORY ==============
 * "Active WorkspaceMember of X-Workspace-Id" — which workspace.context has
 * already proved by the time any method here runs. NO room-level role, NO
 * room_members row, NO new role: "all support can see all room + message".
 * There is nothing further to check, and adding a per-room gate later would
 * silently break the shared-queue model this feature exists to provide.
 *
 * ==== WHY THERE IS A DELETE ENDPOINT AT ALL ==============================
 * MessageEditor::assertDeletableBy returns "sender" only when
 * $message->sender_id === $actor->id — a NULL sender can never match — and then
 * falls through to a moderator branch requiring RoomRole::Owner|Admin. In a
 * shared-table design that would have made VISITOR messages, the content most
 * likely to need removal (a pasted card number, a malicious upload),
 * undeletable by anyone at all. API-226 is the fix, and owning the table is
 * what makes it possible.
 *
 * Every query filters workspace_id explicitly IN ADDITION to the global scope
 * that workspace.context makes effective here (DEC-070): the scope is real
 * protection on this tier — it is what stops a bare find($id) returning another
 * workspace's room — and the explicit filter is what survives a future edit by
 * someone who does not know the scope fails open elsewhere.
 */
class PublicChatAgentController extends Controller
{
    public function __construct(
        private readonly PublicChatService $rooms,
        private readonly PublicChatMessageWriter $writer,
        private readonly PublicChatStaffSerializer $serializer,
        private readonly PublicChatGate $gate,
        private readonly WorkspaceContext $context,
        private readonly AuditLogger $audit,
        private readonly UploadService $uploads,
    ) {}

    /**
     * API-220 GET /public-chat/rooms?status=&assigned=&q=&needs_reply=&cursor=&limit=
     *
     * FILTERING IS SERVER-SIDE, always. `status` is a CSV of the four raw
     * statuses, `assigned` is a ULID or 'me' or 'none', `q` matches the three
     * name columns OR the message bodies (MANDATORY graft 2 — finding a room by
     * what the customer actually said is the point of a support queue), and
     * `needs_reply` is the amber-dot filter.
     *
     * A read: unaffected by the kill switch, so the rail stays usable with a
     * "paused" chip rather than going blank.
     */
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate([
            'status' => ['nullable', 'string', 'max:64'],
            'assigned' => ['nullable', 'string', 'max:40'],
            'q' => ['nullable', 'string', 'max:120'],
            'needs_reply' => ['nullable'],
            'cursor' => ['nullable', 'string', 'max:64'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $limit = (int) ($data['limit'] ?? 30);
        $offset = $this->decodeCursor($data['cursor'] ?? null);
        $viewerId = $request->user()->id;

        $query = $this->rooms->queue($this->workspaceId(), $viewerId, [
            'status' => array_values(array_filter(explode(',', (string) ($data['status'] ?? '')))),
            'assigned' => $data['assigned'] ?? null,
            'q' => $data['q'] ?? null,
            'needs_reply' => filter_var($data['needs_reply'] ?? false, FILTER_VALIDATE_BOOLEAN),
        ]);

        $rows = $query->offset($offset)->limit($limit + 1)->get();
        $hasMore = $rows->count() > $limit;
        $rows = $rows->take($limit);

        $pointers = $this->readPointers($viewerId, $rows->pluck('id')->all());

        return response()->json([
            'rooms' => $rows->map(fn (PublicChatRoom $room) => $this->serializer->room($room, $pointers[$room->id] ?? 0))->values()->all(),
            // Opaque by contract. v1 encodes an offset over the four-key triage
            // sort (problem, needs_reply, recency, id): a keyset cursor over
            // mixed directions plus NULLS LAST is real work for a queue that is
            // measured in hundreds of rows, not millions. Clients MUST treat it
            // as opaque so it can become a keyset later without an API change.
            'next_cursor' => $hasMore ? $this->encodeCursor($offset + $limit) : null,
        ]);
    }

    /** API-221 GET /public-chat/rooms/{id}. */
    public function show(Request $request, string $id): JsonResponse
    {
        $room = $this->roomOrFail($id);
        $pointer = $this->readPointers($request->user()->id, [$room->id])[$room->id] ?? 0;

        return response()->json([
            'room' => $this->serializer->room($room->load('assignedTo'), $pointer),
        ]);
    }

    /** API-222 GET /public-chat/rooms/{id}/messages?after_seq=&before_seq=&limit= */
    public function messages(Request $request, string $id): JsonResponse
    {
        $room = $this->roomOrFail($id);

        $data = $request->validate([
            'after_seq' => ['nullable', 'integer', 'min:0'],
            'before_seq' => ['nullable', 'integer', 'min:0'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $limit = (int) ($data['limit'] ?? 50);

        $query = PublicChatMessage::query()
            ->where('room_id', $room->id)
            ->where('workspace_id', $room->workspace_id)
            ->with(['attachments', 'replyTo', 'senderUser']);

        if (isset($data['after_seq'])) {
            // gap-fill after a reconnect: ascending from the last seen seq
            $messages = $query->where('seq', '>', (int) $data['after_seq'])->orderBy('seq')->limit($limit)->get();
        } else {
            // history: newest first, then flipped so the client always receives
            // ascending seq regardless of which branch served it
            $messages = $query
                ->when(isset($data['before_seq']), fn ($q) => $q->where('seq', '<', (int) $data['before_seq']))
                ->orderByDesc('seq')->limit($limit)->get()->reverse()->values();
        }

        return response()->json([
            'messages' => $this->serializer->messages($messages, $room),
            'last_seq' => (int) $room->last_seq,
        ]);
    }

    /**
     * API-223 POST /public-chat/rooms/{id}/messages — TRIGGERS AUTO-CLAIM.
     *
     * The claim happens inside the writer's lockForUpdate transaction, so
     * "exactly one agent claims an unassigned room under concurrent replies" is
     * a database guarantee rather than a check that races (TC-PCHAT-010).
     *
     * There is no AI branch here, and there must never be one: MessageController
     * dispatches GenerateRoomBotReply for any non-DM room whose body mentions
     * the bot, which in a shared-table design would have had the assistant
     * answering a paying customer in the provider's name. This bounded context
     * is structurally immune — nothing dispatches it — and that immunity is only
     * preserved by not adding it.
     */
    public function send(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $room = $this->roomOrFail($id);

        if ($room->isClosed()) {
            throw ApiException::pchatRoomClosed();
        }

        $data = $request->validate([
            'client_message_id' => ['required', 'string', 'uuid'],
            'body' => ['nullable', 'string'],
            'reply_to_message_id' => ['nullable', 'string', 'ulid'],
            'attachment_ids' => ['nullable', 'array', 'max:10'],
            'attachment_ids.*' => ['string', 'ulid'],
        ]);

        [$message, $created] = $this->writer->write(
            $room,
            PublicChatSenderKind::Agent,
            $request->user(),
            $data['body'] ?? null,
            $data['client_message_id'],
            $data['reply_to_message_id'] ?? null,
            array_values($data['attachment_ids'] ?? []),
        );

        $message->loadMissing(['attachments', 'replyTo', 'senderUser']);

        return response()->json([
            'message' => $this->serializer->message($message, $room),
            'room' => $this->serializer->room($room->load('assignedTo')),
        ], $created ? 201 : 200);
    }

    /**
     * API-224 PATCH /public-chat/rooms/{id} — status and/or assignment.
     *
     * The service writes a system row inside the same lockForUpdate, so the
     * transcript records who changed what, and emits EVT-081 on both channels
     * plus private-workspace.{wid} so every open queue re-sorts.
     *
     * `assigned_to` is only treated as a change when the KEY is present, so
     * `{"assigned_to": null}` is an explicit unassign while omitting it leaves
     * the current assignee alone.
     */
    public function update(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $room = $this->roomOrFail($id);

        $data = $request->validate([
            'status' => ['sometimes', 'string', 'in:'.implode(',', PublicChatStatus::values())],
            'assigned_to' => ['sometimes', 'nullable', 'string', 'ulid'],
        ]);

        $this->rooms->patch($room, $request->user(), $data);

        return response()->json([
            'room' => $this->serializer->room($room->load('assignedTo')),
        ]);
    }

    /**
     * API-225 POST /public-chat/rooms/{id}/uploads — uploader_id = the agent AND
     * public_chat_room_id = the room. Both, deliberately: the agent's identity
     * is real and worth recording, and the partition column is what keeps the
     * file claimable only by a message in THIS conversation.
     *
     * Completion goes through the existing API-061, which asserts
     * uploader_id === $user->id — true for an agent upload and false for a
     * visitor's, which is exactly the fail-closed behaviour wanted.
     */
    public function createUpload(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $room = $this->roomOrFail($id);

        $data = $request->validate([
            'kind' => ['required', 'string', 'in:image,video,file'],
            'filename' => ['required', 'string', 'max:255'],
            'mime_type' => ['required', 'string', 'max:255'],
            'size_bytes' => ['required', 'integer', 'min:1'],
            'sha256' => ['nullable', 'string', 'size:64'],
        ]);

        [$attachment, $putUrl, $multipart] = $this->uploads->createForPublicChat($room, $data, $request->user());

        return response()->json(array_filter([
            'attachment' => ['id' => $attachment->id, 'status' => $attachment->status->value],
            'upload_url' => $putUrl,
            'multipart' => $multipart,
        ], fn ($v) => $v !== null), 201);
    }

    /**
     * API-226 DELETE /public-chat/messages/{id} — soft delete by ANY active
     * workspace member, audited.
     *
     * PublicChatMessage has NO SoftDeletes trait: deleted_at is a plain column,
     * so the row STAYS in every query result and each serializer renders the
     * tombstone itself. That is deliberate — removing the row would renumber the
     * customer's visible seq sequence and break reconnect catch-up.
     */
    public function destroyMessage(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $message = PublicChatMessage::query()
            ->where('workspace_id', $this->workspaceId())
            ->whereKey($id)
            ->first();

        if ($message === null) {
            throw ApiException::pchatRoomNotFound();
        }

        $room = $this->roomOrFail($message->room_id);

        if (! $message->isDeleted()) {
            $message->forceFill([
                'deleted_at' => now(),
                'deleted_by' => $request->user()->id,
            ])->save();

            $this->audit->log('public_chat.message_deleted', $request->user(), 'public_chat_message', $message->id, [
                'room_id' => $room->id,
                'seq' => (int) $message->seq,
                'sender_kind' => $message->sender_kind->value,
            ], $room->workspace_id);

            broadcast(new PublicChatMessageDeleted($room, $message->id, (int) $message->seq));
        }

        return response()->json([
            'message' => $this->serializer->message($message->refresh(), $room),
        ]);
    }

    /**
     * API-227 GET /public-chat/summary — the rail badge (FR-PCHAT-003).
     * A read: it keeps answering with the feature off so the rail can show a
     * "paused" chip instead of vanishing.
     */
    public function summary(Request $request): JsonResponse
    {
        return response()->json([
            'summary' => $this->rooms->summary($this->workspaceId(), $request->user()->id),
            'feature_enabled' => $this->gate->enabled(),
        ]);
    }

    /**
     * API-228 POST /public-chat/rooms/{id}/read {seq} — FR-PCHAT-010.
     *
     * MONOTONIC AT THE DATABASE LEVEL: PublicChatRead::markRead is an
     * ON CONFLICT ... GREATEST() upsert, so a lower seq is a no-op rather than a
     * rewind, and two tabs of the same agent cannot race each other backwards.
     * The response reports the pointer ACTUALLY in force, so a client that sent
     * a stale value learns the truth instead of believing it moved.
     *
     * A read pointer NEVER affects queue order — every agent sees the same queue
     * in the same order (pinned decision 5).
     */
    public function markRead(Request $request, string $id): JsonResponse
    {
        $room = $this->roomOrFail($id);

        $data = $request->validate([
            'seq' => ['required', 'integer', 'min:0'],
        ]);

        $effective = PublicChatRead::markRead(
            $room->id,
            $request->user()->id,
            $room->workspace_id,
            (int) $data['seq'],
        );

        return response()->json([
            'room_id' => $room->id,
            'last_read_seq' => $effective,
            'unread_count' => max(0, (int) $room->last_seq - $effective),
        ]);
    }

    /** EVT-085 staff side — an agent typing is visible to the customer as "support is typing". */
    public function typing(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $room = $this->roomOrFail($id);

        broadcast(new PublicChatTyping($room, PublicChatSenderKind::Agent));
        broadcast(new PublicChatTypingStaff($room, PublicChatSenderKind::Agent, $this->serializer->user($request->user())));

        return response()->json(['ok' => true], 202);
    }

    // ---------------------------------------------------------------- helpers

    private function workspaceId(): string
    {
        $id = $this->context->id();

        if ($id === null) {
            // Unreachable behind workspace.context; a hard failure rather than a
            // query that silently spans every tenant.
            throw ApiException::pchatRoomNotFound();
        }

        return $id;
    }

    /**
     * Resolved WITHOUT withTrashed(): a soft-deleted room is gone for agents
     * too, and 404 is the honest answer. Another workspace's id is likewise a
     * flat 404 — the explicit filter, not the global scope, is what guarantees
     * it (TC-PCHAT-031).
     */
    private function roomOrFail(string $id): PublicChatRoom
    {
        $room = PublicChatRoom::query()
            ->where('workspace_id', $this->workspaceId())
            ->whereKey($id)
            ->first();

        if ($room === null) {
            throw ApiException::pchatRoomNotFound();
        }

        return $room;
    }

    /**
     * FR-PCHAT-010 — one query for the whole page rather than N.
     *
     * @param  list<string>  $roomIds
     * @return array<string, int>
     */
    private function readPointers(string $userId, array $roomIds): array
    {
        if ($roomIds === []) {
            return [];
        }

        return PublicChatRead::query()
            ->where('workspace_id', $this->workspaceId())
            ->where('user_id', $userId)
            ->whereIn('room_id', $roomIds)
            ->pluck('last_read_seq', 'room_id')
            ->map(fn ($v) => (int) $v)
            ->all();
    }

    private function encodeCursor(int $offset): string
    {
        return rtrim(strtr(base64_encode('o:'.$offset), '+/', '-_'), '=');
    }

    private function decodeCursor(?string $cursor): int
    {
        if ($cursor === null || $cursor === '') {
            return 0;
        }

        $raw = (string) base64_decode(strtr($cursor, '-_', '+/'), true);

        return str_starts_with($raw, 'o:') ? max(0, (int) substr($raw, 2)) : 0;
    }
}
