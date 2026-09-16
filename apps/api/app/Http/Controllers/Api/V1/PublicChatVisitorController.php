<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\UploadService;
use App\Domain\PublicChat\PublicChatGate;
use App\Domain\PublicChat\PublicChatMessageWriter;
use App\Domain\PublicChat\PublicChatPublicSerializer;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Events\PublicChatTyping;
use App\Events\PublicChatTypingStaff;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\Attachment;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Broadcast;

/**
 * TIER 2 — FR-PCHAT-007/011/012/013/014/016 · API-210..216.
 * UNAUTHENTICATED. THE 64-HEX CODE IS THE CREDENTIAL (DEC-063).
 *
 * ==== THE THREAT MODEL THIS CLASS LIVES IN ================================
 * Possession of /support/<code> IS the identity. There is no device binding in
 * v1: a forwarded link transfers full access, bounded only by expires_at, the
 * nginx no-referrer / no-store / access_log-off hygiene block, and API-203
 * rotate-link. That is a deliberate, recorded concession (R4) — do not paper
 * over it with a second half-credential.
 *
 * ==== FOUR RULES, NONE OF THEM OPTIONAL ===================================
 * 1. EVERY query filters workspace_id explicitly and uses withoutGlobalScopes().
 *    No workspace.context middleware runs here, and WorkspaceScope::apply()
 *    no-ops SILENTLY with no context — it fails OPEN, returning every tenant's
 *    rows while looking like correct code (DEC-070 / MANDATORY fix 8).
 * 2. THE RAW `status` NEVER LEAVES THIS TIER. Everything visitor-facing carries
 *    `status_public`; a customer discovering support flagged their conversation
 *    `problem` is a disclosure with a real business cost (MANDATORY graft 1).
 * 3. room.meta — the partner's "...etc data" — is NEVER serialised here.
 * 4. Every response sends Cache-Control: no-store. The URL is a capability.
 *
 * ==== A SIGNED-IN AGENT WHO OPENS THE LINK (FR-PCHAT-013 / graft 18) ======
 * packages/api-client attaches the member's bearer to EVERY request, so without
 * an explicit check an agent checking on a conversation would post a message
 * recorded as coming from the customer. Reads are served as the visitor; WRITES
 * ARE 403 PCHAT_SIGNED_IN. An invalid or expired bearer is 401 — never silently
 * anonymous, because "your token is dead so you are now the customer" is the
 * worst possible failure mode here.
 */
class PublicChatVisitorController extends Controller
{
    public function __construct(
        private readonly PublicChatGate $gate,
        private readonly PublicChatMessageWriter $writer,
        private readonly PublicChatPublicSerializer $serializer,
        private readonly WorkspaceContext $context,
        private readonly UploadService $uploads,
    ) {}

    /**
     * API-210 GET /public-chat/{code}.
     *
     * DELIBERATELY 200 WHEN THE FEATURE IS OFF, not 503 (DEC-067): the page then
     * shows a calm "support is temporarily unavailable" banner over a still
     * readable transcript, instead of an error page that loses the customer's
     * receipt. can_send carries the real answer.
     *
     * `room.id` is returned because the visitor page cannot derive the room ULID
     * from its code and needs it to subscribe to private-public-chat.{id}.
     */
    public function show(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $viewer = $this->viewer($request);

        return $this->noStore([
            'room' => $this->serializer->room($room),
            'viewer' => $viewer,
            'feature_enabled' => $this->gate->enabled(),
            'can_send' => $this->canSend($room, $viewer),
            'closed_reason' => $this->closedReason($room),
        ]);
    }

    /**
     * API-211 GET /public-chat/{code}/messages?after_seq=&limit= — reconnect
     * catch-up and the 5s polling fallback when the socket will not connect.
     * A read, so it answers with the feature off.
     */
    public function messages(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $this->viewer($request); // a dead bearer is 401 even on a read

        $data = $request->validate([
            'after_seq' => ['nullable', 'integer', 'min:0'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $messages = PublicChatMessage::withoutGlobalScopes()
            ->where('room_id', $room->id)
            ->where('workspace_id', $room->workspace_id)
            ->when(isset($data['after_seq']), fn ($q) => $q->where('seq', '>', (int) $data['after_seq']))
            ->with(['attachments', 'replyTo'])
            ->orderBy('seq')
            ->limit((int) ($data['limit'] ?? 100))
            ->get();

        return $this->noStore([
            'messages' => $this->serializer->messages($messages, $room),
            'last_seq' => (int) $room->last_seq,
        ]);
    }

    /**
     * API-212 POST /public-chat/{code}/messages.
     *
     * client_message_id is REQUIRED and must be a UUID (graft 13 / graft 26 /
     * pinned decision 4). Required, because the column is NOT NULL and a client
     * that may omit it gets no idempotency at all. A UUID, because the
     * idempotency unique is (room_id, sender_kind, client_message_id) and a
     * free-form visitor value is exactly what a squatter would use — sender_kind
     * already keeps a visitor out of an agent's key space, and the UUID
     * constraint removes the incentive to try.
     *
     * DEC-069 — a visitor message NEVER auto-reopens a `done` room: a stale link
     * could otherwise resurrect a closed ticket with no agent seeing it.
     */
    public function send(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $this->assertVisitorMayWrite($request, $room);

        $data = $request->validate([
            'client_message_id' => ['required', 'string', 'uuid'],
            'body' => ['nullable', 'string'],
            'reply_to_message_id' => ['nullable', 'string', 'ulid'],
            'attachment_ids' => ['nullable', 'array', 'max:10'],
            'attachment_ids.*' => ['string', 'ulid'],
        ]);

        [$message, $created] = $this->writer->write(
            $room,
            // sender_kind is set SERVER-SIDE from the tier, never from the
            // payload. Tier 2 has no code path that can write 'agent', which is
            // what makes visitor->agent impersonation structurally impossible.
            PublicChatSenderKind::Visitor,
            null,
            $data['body'] ?? null,
            $data['client_message_id'],
            $data['reply_to_message_id'] ?? null,
            array_values($data['attachment_ids'] ?? []),
        );

        $message->loadMissing(['attachments', 'replyTo']);

        return $this->noStore([
            'message' => $this->serializer->message($message, $room),
        ], $created ? 201 : 200);
    }

    /**
     * API-213 POST /public-chat/{code}/uploads — FR-PCHAT-020 / DEC-068.
     *
     * 'avatar' is rejected 422 BEFORE UploadService is reached: an avatar is an
     * account-level artefact and has no meaning for a visitor, and rejecting it
     * at the request layer means the shared service never has to reason about a
     * caller it was not written for. claimAttachments would refuse it anyway —
     * two layers on purpose.
     *
     * The attachment row gets uploader_id = NULL and public_chat_room_id =
     * $room->id, which is the ONE shared surface with the internal media
     * pipeline. The mime sniffing, blocked-extension list and per-kind size caps
     * are deliberately NOT forked (DEC-068): duplicating them would guarantee
     * drift in exactly the checks that matter.
     */
    public function createUpload(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $this->assertVisitorMayWrite($request, $room);

        $data = $request->validate([
            'kind' => ['required', 'string', 'in:image,video,file'],
            'filename' => ['required', 'string', 'max:255'],
            'mime_type' => ['required', 'string', 'max:255'],
            'size_bytes' => ['required', 'integer', 'min:1'],
            'sha256' => ['nullable', 'string', 'size:64'],
        ]);

        [$attachment, $putUrl, $multipart] = $this->uploads->createForPublicChat($room, $data);

        return $this->noStore(array_filter([
            'attachment' => ['id' => $attachment->id, 'status' => $attachment->status->value],
            'upload_url' => $putUrl,
            'multipart' => $multipart,
        ], fn ($v) => $v !== null), 201);
    }

    /** API-214 POST /public-chat/{code}/uploads/{attachment}/complete. */
    public function completeUpload(Request $request, string $code, string $attachmentId): JsonResponse
    {
        $room = $this->resolve($code);
        $this->assertVisitorMayWrite($request, $room);

        $data = $request->validate([
            'parts' => ['nullable', 'array'],
            'parts.*.part_number' => ['required_with:parts', 'integer'],
            'parts.*.etag' => ['required_with:parts', 'string'],
        ]);

        // ROOM-scoped ownership, never uploader-scoped: a visitor upload has
        // uploader_id NULL by design, so "is this yours?" has no meaning. The
        // partition column IS the ownership test.
        $attachment = Attachment::withoutGlobalScopes()
            ->whereKey($attachmentId)
            ->where('workspace_id', $room->workspace_id)
            ->where('public_chat_room_id', $room->id)
            ->first();

        if ($attachment === null) {
            throw ApiException::msgAttachmentInvalid();
        }

        $attachment = $this->uploads->completeForPublicChat($attachment, $room, $data['parts'] ?? null);

        return $this->noStore([
            'attachment' => ['id' => $attachment->id, 'status' => $attachment->status->value],
        ]);
    }

    /**
     * API-215 POST /public-chat/{code}/broadcasting/auth.
     *
     * ############ READ THIS BEFORE CHANGING ONE CHARACTER BELOW ############
     * THIS ENDPOINT IS AN UNAUTHENTICATED SIGNING ORACLE OVER THE REVERB APP
     * SECRET. PusherBroadcaster::validAuthenticationResponse() short-circuits on
     * any channel name starting with "private" and signs
     * "socket_id:channel_name" with the app secret. IT PERFORMS NO OWNERSHIP
     * CHECK OF ITS OWN. The literal string equality on the line below is the
     * ENTIRE tenancy boundary of the realtime path.
     *
     * It is NOT a prefix match, NOT a regex, NOT str_starts_with and NOT
     * str_contains — there is exactly ONE legal channel name per code, and that
     * is why the assertion can be an equality. Relaxing it to a "harmless
     * generalisation" hands one visitor every other customer's transcript, and
     * nothing backs it up: config/reverb.php sets allowed_origins => ['*'] and
     * there is no config/cors.php, so neither origin checking nor CORS is a
     * backstop. TC-PCHAT-017/018 are SECURITY tests, not integration tests.
     *
     * It also explicitly rejects private-public-chat-staff.{id}, which is not
     * derivable from any visitor input and must never be signable here.
     *
     * socket_id is validated with \A..\z anchors, never ^..$ — '$' also matches
     * before a trailing newline, which is exactly how a smuggled value slips
     * past a naive anchor.
     * #######################################################################
     *
     * A READ: it answers with the feature off, so an open page keeps its socket
     * across a disable/enable cycle. A signed-in member may authorise the
     * visitor channel (they are allowed to WATCH as the visitor; they are not
     * allowed to WRITE as one).
     */
    public function broadcastAuth(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $this->viewer($request); // a dead bearer is still 401

        $socketId = (string) $request->input('socket_id', '');
        $channelName = (string) $request->input('channel_name', '');

        if (preg_match('/\A\d+\.\d+\z/', $socketId) !== 1) {
            throw new ApiException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 422, [
                'fields' => ['socket_id' => ['รูปแบบไม่ถูกต้อง']],
            ]);
        }

        if ($channelName !== 'private-public-chat.'.$room->id) {
            throw ApiException::pchatRoomNotFound();
        }

        return response()->json(
            Broadcast::driver()->validAuthenticationResponse($request, [])
        )->header('Cache-Control', 'no-store');
    }

    /**
     * API-216 POST /public-chat/{code}/typing — EVT-085.
     * The visitor variant carries sender_kind and nothing else; the staff
     * variant tells agents a customer is typing.
     */
    public function typing(Request $request, string $code): JsonResponse
    {
        $room = $this->resolve($code);
        $this->assertVisitorMayWrite($request, $room);

        broadcast(new PublicChatTyping($room, PublicChatSenderKind::Visitor));
        broadcast(new PublicChatTypingStaff($room, PublicChatSenderKind::Visitor));

        return $this->noStore(['ok' => true], 202);
    }

    // ---------------------------------------------------------------- helpers

    /**
     * Resolve by code, then establish the workspace context.
     *
     * ->withTrashed() is required, not cosmetic: PublicChatRoom uses SoftDeletes,
     * so a soft-deleted room is invisible to a normal query and would answer 404
     * when the honest answer — and the one every other expired-link path gives —
     * is 410. After expiry, rotation or soft-delete EVERY Tier-2 route including
     * broadcasting/auth answers 410, so an open socket cannot outlive the link.
     *
     * The context is set for defence in depth only. It does NOT excuse the
     * explicit workspace_id filters — every query on this tier carries both.
     */
    private function resolve(string $code): PublicChatRoom
    {
        $room = PublicChatRoom::withoutGlobalScopes()
            ->withTrashed()
            ->where('code', $code)
            ->first();

        if ($room === null) {
            // A rotated code lands here too, and 404 is the right answer for it:
            // the old link simply does not exist any more.
            throw ApiException::pchatRoomNotFound();
        }

        if ($room->trashed() || $room->isExpired()) {
            throw ApiException::pchatLinkExpired($room->expires_at?->toIso8601String());
        }

        $workspace = Workspace::withoutGlobalScopes()->find($room->workspace_id);

        if ($workspace === null) {
            throw ApiException::pchatRoomNotFound();
        }

        // WorkspaceContext::set accepts a null membership — a visitor is a
        // member of nothing.
        $this->context->set($workspace, null);

        return $room;
    }

    /**
     * FR-PCHAT-013 — who is holding this link?
     *
     * No bearer          -> null (the visitor).
     * Valid bearer       -> {kind:'member', display_name}; reads are served,
     *                       writes are 403 PCHAT_SIGNED_IN.
     * Invalid/expired    -> 401. NEVER silently anonymous: an agent whose token
     *                       just expired must not be quietly promoted to "the
     *                       customer" and allowed to post as them.
     *
     * Workspace membership is deliberately NOT consulted. Being signed in AT ALL
     * is the disqualifier, because the shared ApiClient attaches the token to
     * every request regardless of which workspace the page belongs to.
     *
     * @return array{kind: string, display_name: string}|null
     */
    private function viewer(Request $request): ?array
    {
        $bearer = $request->bearerToken();

        if ($bearer === null || $bearer === '') {
            return null;
        }

        $user = Auth::guard('api')->user();

        if (! $user instanceof User) {
            throw ApiException::tokenInvalid();
        }

        return ['kind' => 'member', 'display_name' => $user->display_name];
    }

    /** The write-side gate: feature on, link live, room open, not signed in. */
    private function assertVisitorMayWrite(Request $request, PublicChatRoom $room): void
    {
        $this->gate->assertEnabled();

        if ($this->viewer($request) !== null) {
            throw ApiException::pchatSignedIn();
        }

        if ($room->isClosed()) {
            throw ApiException::pchatRoomClosed();
        }
    }

    /**
     * @param  array{kind: string, display_name: string}|null  $viewer
     */
    private function canSend(PublicChatRoom $room, ?array $viewer): bool
    {
        return $this->gate->enabled()
            && ! $room->isExpired()
            && $room->statusPublic() === PublicChatStatus::PUBLIC_OPEN
            && $viewer === null;
    }

    private function closedReason(PublicChatRoom $room): ?string
    {
        if (! $this->gate->enabled()) {
            return 'disabled';
        }

        return $room->isClosed() ? 'done' : null;
    }

    /**
     * The URL is a capability, so nothing it returns may sit in a shared cache
     * or a proxy. Applied to EVERY Tier-2 response without exception.
     *
     * @param  array<string, mixed>  $payload
     */
    private function noStore(array $payload, int $status = 200): JsonResponse
    {
        return response()->json($payload, $status)
            ->header('Cache-Control', 'no-store')
            ->header('Referrer-Policy', 'no-referrer');
    }
}
