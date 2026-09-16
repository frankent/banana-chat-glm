<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\PublicChat\PublicChatGate;
use App\Domain\PublicChat\PublicChatService;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Http\Middleware\VerifyPublicChatSignature;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * TIER 1 — FR-PCHAT-030/031 · API-200/201/202/203.
 * Prefix `/api/v1/partner/public-chat`, middleware `api.hmac`.
 *
 * ==== THE `partner/` PREFIX IS LOAD-BEARING ================================
 * Without it, partner and agent room routes are the same path in two different
 * middleware groups, disambiguated only by a route regex — and a dropped
 * ->where() would silently reroute a customer request into the AUTHENTICATED
 * handler. It also gives the nginx `access_log off` exemption a path to match.
 *
 * ==== ROOMS ARE ADDRESSED BY ULID, NEVER BY {code} (MANDATORY graft 12) ====
 * A {code} path would send the VISITOR'S bearer credential on every partner
 * status poll — into the partner's outbound HTTP logs, any intermediate proxy,
 * and our own nginx access log. API-200 returns room.id and every later partner
 * call uses it; a 64-hex value in {id} is a plain 404 because the route is
 * ->whereUlid('id').
 *
 * ==== NG6's BOUND, STATED SO NOBODY WIDENS IT =============================
 * DEC-061 permits EXACTLY: create a room, read its status (NEVER message
 * bodies), close it, and rotate its link — within the key's own workspace, and
 * nothing else, ever. There is deliberately no partner endpoint that sends a
 * message, reads a transcript, or reads as a user.
 *
 * ==== AUTHORISATION ========================================================
 * VerifyPublicChatSignature has already verified the signature, the clock skew
 * and the nonce, has confirmed the key is unrevoked and its workspace Active,
 * and has set WorkspaceContext. It hands the key over as a request attribute.
 * Every query below STILL filters workspace_id explicitly (DEC-070): the room
 * is addressed by an id the partner supplies, and pinning it to this key's
 * workspace is what makes a cross-tenant id a 404 instead of a leak.
 *
 * The feature gate is checked HERE, not in the middleware, and only on writes —
 * see PublicChatGate.
 */
class PublicChatPartnerController extends Controller
{
    public function __construct(
        private readonly PublicChatService $rooms,
        private readonly PublicChatGate $gate,
    ) {}

    /**
     * API-200 POST /partner/public-chat/rooms — create a conversation.
     * 201 on create, 200 on an external_ref idempotent replay (the SAME room id
     * and the SAME code come back — a replay is not an error).
     */
    public function store(Request $request): JsonResponse
    {
        $this->gate->assertEnabled();

        $key = $this->key($request);

        $data = $request->validate([
            'customer_name' => ['required', 'string', 'max:120'],
            'provider_name' => ['required', 'string', 'max:120'],
            'external_ref' => ['nullable', 'string', 'max:120'],
            'locale' => ['nullable', 'string', 'in:th,en'],
            'meta' => ['nullable', 'array'],
        ]);

        // The partner's arbitrary "...etc data with payload" is stored, never
        // served to the visitor, and capped so one call cannot park megabytes in
        // a jsonb column.
        if (isset($data['meta']) && strlen((string) json_encode($data['meta'])) > 8192) {
            throw new ApiException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 422, [
                'fields' => ['meta' => ['ต้องมีขนาดไม่เกิน 8KB']],
            ]);
        }

        [$room, $created] = $this->rooms->create($key, $data);

        return response()->json([
            'room' => $this->partnerRoom($room),
            'url' => $this->rooms->publicUrl($room),
        ], $created ? 201 : 200)->header('Cache-Control', 'no-store');
    }

    /**
     * API-201 GET /partner/public-chat/rooms/{id}.
     *
     * STILL ANSWERS WHEN THE FEATURE IS OFF (DEC-067): reads and data survive a
     * disable, and a partner polling ticket status must not see their
     * integration break because an admin paused new conversations.
     *
     * Returns the RAW status — the partner owns the ticket and needs to know it
     * was flagged `problem`. The VISITOR never sees it; that asymmetry is the
     * whole point of `status_public` (MANDATORY graft 1).
     * `assigned_display_name` is the EXTERNAL name only. Message bodies are
     * never returned here — NG6's bound is status, not transcript.
     */
    public function show(Request $request, string $id): JsonResponse
    {
        $room = $this->roomOrFail($request, $id);

        return response()->json([
            'room' => $this->partnerRoom($room, withCounts: true),
        ])->header('Cache-Control', 'no-store');
    }

    /** API-202 POST /partner/public-chat/rooms/{id}/close. */
    public function close(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $key = $this->key($request);
        $room = $this->roomOrFail($request, $id);

        $this->rooms->close($room, $key);

        return response()->json([
            'room' => $this->partnerRoom($room),
        ])->header('Cache-Control', 'no-store');
    }

    /**
     * API-203 POST /partner/public-chat/rooms/{id}/rotate-link — MANDATORY
     * grafts 5/16/24.
     *
     * The old code stops resolving immediately, so every Tier-2 route 404s for
     * it at once. THE PARTNER MUST RE-DELIVER the returned url — a rotation the
     * partner cannot observe is useless — and an already-connected socket is NOT
     * evicted, because the channel is keyed by the room ULID rather than by the
     * code. Both bounds are stated in the partner docs, not buried.
     */
    public function rotateLink(Request $request, string $id): JsonResponse
    {
        $this->gate->assertEnabled();

        $key = $this->key($request);
        $room = $this->roomOrFail($request, $id);

        if ($room->isClosed()) {
            throw ApiException::pchatRoomClosed();
        }

        $this->rooms->rotateLink($room, $key);

        return response()->json([
            'room' => $this->partnerRoom($room),
            'url' => $this->rooms->publicUrl($room),
        ])->header('Cache-Control', 'no-store');
    }

    private function key(Request $request): PublicChatApiKey
    {
        $key = $request->attributes->get(VerifyPublicChatSignature::REQUEST_ATTRIBUTE);

        // Unreachable behind `api.hmac`; a hard failure rather than a silent
        // unscoped query if this controller is ever wired without it.
        if (! $key instanceof PublicChatApiKey) {
            throw ApiException::apiKeyInvalid();
        }

        return $key;
    }

    /**
     * withoutGlobalScopes + an EXPLICIT workspace_id filter. The scope is inert
     * on this tier anyway (context is established BY the key lookup, so a
     * forgotten filter would fail OPEN and silently), and pinning to
     * $key->workspace_id is what makes another tenant's room id a flat 404.
     *
     * A soft-deleted room is resolved ->withTrashed() so it can answer 410
     * rather than 404 — the partner should learn the conversation ended, not
     * that their id is wrong.
     */
    private function roomOrFail(Request $request, string $id): PublicChatRoom
    {
        $key = $this->key($request);

        $room = PublicChatRoom::withoutGlobalScopes()
            ->withTrashed()
            ->whereKey($id)
            ->where('workspace_id', $key->workspace_id)
            ->first();

        if ($room === null) {
            throw ApiException::pchatRoomNotFound();
        }

        if ($room->trashed()) {
            throw ApiException::pchatLinkExpired($room->expires_at?->toIso8601String());
        }

        return $room;
    }

    /**
     * @return array<string, mixed>
     */
    private function partnerRoom(PublicChatRoom $room, bool $withCounts = false): array
    {
        $payload = [
            'id' => $room->id,
            'code' => $room->code,
            'status' => $room->status->value,
            'customer_name' => $room->customer_name,
            'provider_name' => $room->provider_name,
            'external_ref' => $room->external_ref,
            'locale' => $room->locale,
            // The EXTERNAL display name only: "Provider (username)" from the
            // room's provider name and the assignee's username. The partner gets
            // no user ULID and no internal display name.
            'assigned_display_name' => $room->assigned_to === null
                ? null
                : $room->provider_name.' ('.($room->assignedTo?->username ?? '').')',
            'created_at' => $room->created_at?->toIso8601String(),
            'last_message_at' => $room->last_message_at?->toIso8601String(),
            'closed_at' => $room->closed_at?->toIso8601String(),
            'expires_at' => $room->expires_at?->toIso8601String(),
        ];

        if ($withCounts) {
            $payload['message_count'] = PublicChatMessage::withoutGlobalScopes()
                ->where('room_id', $room->id)
                ->where('workspace_id', $room->workspace_id)
                ->whereNull('deleted_at')
                ->count();
        }

        return $payload;
    }
}
