<?php

namespace App\Domain\PublicChat;

use App\Enums\MemberStatus;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Events\PublicChatRoomCreated;
use App\Exceptions\ApiException;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * FR-PCHAT-001/009/012 — room lifecycle: create, close, rotate-link, status and
 * assignment transitions, the agent queue query and the rail summary.
 *
 * EVERY QUERY IN THIS CLASS FILTERS workspace_id EXPLICITLY, and the Tier-1 /
 * Tier-2 paths additionally use withoutGlobalScopes(). WorkspaceScope::apply()
 * no-ops SILENTLY when no context is set (Models/Scopes/WorkspaceScope.php:20)
 * — it fails OPEN, returning every tenant's rows while looking like correct
 * code — and the partner and visitor surfaces resolve a room BEFORE any context
 * exists. DEC-070: keep both defences, remove neither.
 */
class PublicChatService
{
    public function __construct(
        private readonly PublicChatGate $gate,
        private readonly AuditLogger $audit,
        private readonly PublicChatMessageWriter $writer,
        private readonly PublicChatStaffSerializer $staff,
    ) {}

    /**
     * API-200. Idempotent on (workspace_id, external_ref): the partner retrying
     * a create — including after a key rotation, which is why the unique index
     * deliberately excludes api_key_id — gets 200 and the SAME room id and the
     * SAME code back, not a second conversation.
     *
     * @param  array{customer_name: string, provider_name: string, external_ref?: ?string, locale?: ?string, meta?: ?array<string, mixed>}  $input
     * @return array{0: PublicChatRoom, 1: bool} [room, created]
     */
    public function create(PublicChatApiKey $key, array $input): array
    {
        $externalRef = $this->sanitizeText($input['external_ref'] ?? null, 120, required: false);

        if ($externalRef !== null) {
            $existing = $this->findByExternalRef($key->workspace_id, $externalRef);

            if ($existing !== null) {
                return [$existing, false];
            }
        }

        $attributes = [
            'workspace_id' => $key->workspace_id,
            'api_key_id' => $key->id,
            'code' => PublicChatRoom::generateCode(),
            // XSS AT INGEST: length cap + control/bidi stripping happen HERE,
            // because ingest is the only defence that travels with the data into
            // a future push payload, CSV export or email template. React, blade
            // and the CSV writer each escape again on the way out.
            'customer_name' => $this->sanitizeText($input['customer_name'] ?? null, 120, required: true),
            'provider_name' => $this->sanitizeText($input['provider_name'] ?? null, 120, required: true),
            'status' => PublicChatStatus::New->value,
            'external_ref' => $externalRef,
            'meta' => $input['meta'] ?? null,
            'locale' => in_array($input['locale'] ?? null, ['th', 'en'], true) ? $input['locale'] : 'th',
            'expires_at' => now()->addDays($this->gate->linkTtlDays()),
        ];

        try {
            $room = PublicChatRoom::withoutGlobalScopes()->create($attributes);
        } catch (QueryException $e) {
            // Two partner requests racing on the same external_ref: the partial
            // unique index resolves the race, and the loser replays rather than
            // 500s. 23505 = unique_violation.
            if ($externalRef !== null && ($e->getCode() === '23505' || str_contains($e->getMessage(), 'public_chat_rooms_ws_external_ref_uniq'))) {
                $existing = $this->findByExternalRef($key->workspace_id, $externalRef);

                if ($existing !== null) {
                    return [$existing, false];
                }
            }

            throw $e;
        }

        $this->audit->system('public_chat.room_created', $key->workspace_id, 'public_chat_room', $room->id, [
            'api_key_id' => $key->key_id, // key_id is the PUBLIC identifier; never the secret
            'external_ref' => $externalRef,
        ]);

        // EVT-082 — the agents' queue and rail badge move without a poll.
        broadcast(new PublicChatRoomCreated($room, $this->staff->room($room)));

        return [$room, true];
    }

    private function findByExternalRef(string $workspaceId, string $externalRef): ?PublicChatRoom
    {
        return PublicChatRoom::withoutGlobalScopes()
            ->where('workspace_id', $workspaceId)
            ->where('external_ref', $externalRef)
            ->first();
    }

    /** The visitor URL. The code appears in the PATH only — never a query string. */
    public function publicUrl(PublicChatRoom $room): string
    {
        return rtrim((string) config('app.url'), '/').'/support/'.$room->code;
    }

    /**
     * API-202 — the partner closes the ticket. 409 if already closed: a
     * double-close is a partner bug worth reporting, not a silent no-op.
     */
    public function close(PublicChatRoom $room, PublicChatApiKey $key): PublicChatRoom
    {
        if ($room->isClosed()) {
            throw ApiException::pchatRoomClosed();
        }

        DB::transaction(function () use ($room): void {
            /** @var PublicChatRoom $locked */
            $locked = PublicChatRoom::withoutGlobalScopes()
                ->whereKey($room->id)
                ->where('workspace_id', $room->workspace_id)
                ->lockForUpdate()
                ->firstOrFail();

            $from = $locked->status;

            $locked->forceFill([
                'status' => PublicChatStatus::Done->value,
                'closed_at' => now(),
            ])->save();

            $this->writer->appendSystem($locked, PublicChatSystemEvent::ClosedByCustomer, [
                'from' => $from->value,
                'to' => PublicChatStatus::Done->value,
            ]);

            $room->setRawAttributes($locked->getAttributes(), true);
        });

        $this->audit->system('public_chat.room_closed', $room->workspace_id, 'public_chat_room', $room->id, [
            'api_key_id' => $key->key_id,
            'by' => 'partner',
        ]);

        $this->broadcastLifecycle($room);

        return $room;
    }

    /**
     * API-203 — MANDATORY grafts 5/16/24. The ONLY remedy for a leaked capability
     * URL short of ending the conversation. The old code 404s on every Tier-2
     * route IMMEDIATELY (it simply no longer resolves) while the transcript,
     * status and assignment continue untouched.
     *
     * STATED BOUND, HONESTLY: an ALREADY-CONNECTED socket is NOT force-
     * disconnected, because the channel is keyed by the room ULID and not by the
     * code — which is the same property that keeps the credential out of every
     * WebSocket frame. Rotation stops NEW access with the old link; it does not
     * evict a live one. The partner MUST re-deliver the returned url: a rotation
     * the partner cannot observe is useless.
     */
    public function rotateLink(PublicChatRoom $room, PublicChatApiKey $key): PublicChatRoom
    {
        DB::transaction(function () use ($room): void {
            /** @var PublicChatRoom $locked */
            $locked = PublicChatRoom::withoutGlobalScopes()
                ->whereKey($room->id)
                ->where('workspace_id', $room->workspace_id)
                ->lockForUpdate()
                ->firstOrFail();

            $locked->forceFill([
                'code' => PublicChatRoom::generateCode(),
                'expires_at' => now()->addDays($this->gate->linkTtlDays()),
            ])->save();

            $room->setRawAttributes($locked->getAttributes(), true);
        });

        // The new code is NEVER audited — the audit trail is read by admins in a
        // UI that has no business holding a live visitor credential.
        $this->audit->system('public_chat.link_rotated', $room->workspace_id, 'public_chat_room', $room->id, [
            'api_key_id' => $key->key_id,
        ]);

        return $room;
    }

    /**
     * API-224 — status and/or assignment, one transaction, one system row per
     * change, and the state-consistency guard from MANDATORY graft 28.
     *
     * THE GUARD, stated exactly: a room may not sit in any status other than
     * `new` with a NULL assignee. That single rule covers both halves of the
     * graft — it blocks "leave new while unassigned" and it blocks "unassign
     * while in_progress" — and keeps the queue's "which agent is taking that
     * room" column coherent. It is deliberately the ONLY transition guard: a
     * support queue that refuses a legitimate state change is worse than one
     * that allows an unusual one.
     *
     * @param  array{status?: ?string, assigned_to?: ?string}  $changes  presence of the KEY is what
     *                                                                   requests a change; `assigned_to => null` is an explicit unassign
     */
    public function patch(PublicChatRoom $room, User $actor, array $changes): PublicChatRoom
    {
        $wantsStatus = array_key_exists('status', $changes);
        $wantsAssignee = array_key_exists('assigned_to', $changes);

        $requestedStatus = $wantsStatus
            ? (PublicChatStatus::tryFrom((string) $changes['status']) ?? throw ApiException::pchatInvalidTransition($room->status->value, (string) $changes['status']))
            : null;

        $requestedAssignee = $wantsAssignee ? $changes['assigned_to'] : null;

        // Membership is checked before the lock: it cannot change under us in a
        // way that matters, and it is the one check that touches another table.
        if ($wantsAssignee && $requestedAssignee !== null) {
            $this->assertAssignable($room->workspace_id, (string) $requestedAssignee);
        }

        $events = [];
        // DEC-074 — set inside the transaction, read after it commits.
        $visitorDelta = true;

        DB::transaction(function () use ($room, $actor, $wantsStatus, $wantsAssignee, $requestedStatus, $requestedAssignee, &$events, &$visitorDelta): void {
            /** @var PublicChatRoom $locked */
            $locked = PublicChatRoom::withoutGlobalScopes()
                ->whereKey($room->id)
                ->where('workspace_id', $room->workspace_id)
                ->lockForUpdate()
                ->firstOrFail();

            $fromStatus = $locked->status;
            $fromAssignee = $locked->assigned_to;
            // DEC-074 — captured INSIDE the lock, against the row the write
            // actually mutates, for the same reason the transition guard is.
            $fromStatusPublic = $fromStatus->public();

            // THE GUARD IS EVALUATED AGAINST THE LOCKED ROW, not the row the
            // caller read. Checking it outside the lock would let two agents —
            // one sending {assigned_to: null, status: new}, the other sending
            // {status: in_progress} — each pass against their own stale snapshot
            // and commit a room that is `in_progress` with a NULL assignee. Like
            // auto-claim, the invariant is a database guarantee, not a check.
            $nextStatus = $wantsStatus ? $requestedStatus : $fromStatus;
            $nextAssignee = $wantsAssignee ? $requestedAssignee : $fromAssignee;

            if ($nextStatus !== PublicChatStatus::New && $nextAssignee === null) {
                throw ApiException::pchatInvalidTransition($fromStatus->value, $nextStatus->value);
            }

            $updates = [];

            if ($wantsAssignee && $nextAssignee !== $fromAssignee) {
                $updates['assigned_to'] = $nextAssignee;
                $updates['claimed_at'] = $nextAssignee === null ? null : now();
            }

            if ($wantsStatus && $nextStatus !== $fromStatus) {
                $updates['status'] = $nextStatus->value;
                // DEC-069 — no auto-reopen from a visitor message, but an agent
                // reopening is explicit and must clear closed_at so the room
                // stops reading as a receipt.
                $updates['closed_at'] = $nextStatus === PublicChatStatus::Done ? now() : null;
            }

            if ($updates === []) {
                $room->setRawAttributes($locked->getAttributes(), true);

                return;
            }

            $locked->forceFill($updates)->save();

            if (array_key_exists('assigned_to', $updates)) {
                $events[] = $this->writer->appendSystem(
                    $locked,
                    $fromAssignee === null ? PublicChatSystemEvent::Claimed : PublicChatSystemEvent::Reassigned,
                    array_filter([
                        'actor_username' => $actor->username,
                        'from_user_id' => $fromAssignee,
                        'to_user_id' => $nextAssignee,
                    ], fn ($v) => $v !== null),
                );
            }

            if (array_key_exists('status', $updates)) {
                $events[] = $this->writer->appendSystem($locked, PublicChatSystemEvent::StatusChanged, [
                    'from' => $fromStatus->value,
                    'to' => $nextStatus->value,
                    'actor_username' => $actor->username,
                ]);
            }

            $room->setRawAttributes($locked->getAttributes(), true);

            // DEC-074 — did anything the VISITOR can see actually move? Only
            // the status projection is visitor-visible on EVT-081: assignment
            // and reassignment never change it, and new|in_progress|problem all
            // project to 'open'. When the answer is no, the visitor frame is
            // suppressed alongside the zero-delta system row, because an empty
            // frame arriving at the instant support flags a customer leaks the
            // flag just as surely as a rendered row would.
            $visitorDelta = $fromStatusPublic !== $locked->status->public();
        });

        if ($events === []) {
            return $room;
        }

        $this->audit->log('public_chat.room_updated', $actor, 'public_chat_room', $room->id, [
            'status' => $room->status->value,
            'assigned_to' => $room->assigned_to,
        ], $room->workspace_id);

        foreach ($events as $systemRow) {
            $this->writer->broadcastMessage($room, $systemRow);
        }

        $this->broadcastLifecycle($room, $visitorDelta);

        return $room;
    }

    /**
     * EVT-081, both variants, after any lifecycle change.
     *
     * DEC-074 — $visitorVisible defaults TRUE so every other caller (API-202
     * partner close, API-203 rotate) is unchanged: those genuinely move
     * status_public or can_send and the visitor must be told. Only patch(),
     * which can produce a transition invisible to the projection, ever passes
     * false.
     */
    public function broadcastLifecycle(PublicChatRoom $room, bool $visitorVisible = true): void
    {
        $this->writer->broadcastRoomChanged($room, $visitorVisible);
    }

    /**
     * Decision A — authorisation for public chat is "active WorkspaceMember of
     * this workspace", full stop: no room-level role, no room_members row, no
     * new role. The assignee must clear the same bar the assigner did.
     */
    private function assertAssignable(string $workspaceId, string $userId): void
    {
        $ok = WorkspaceMember::query()
            ->withoutGlobalScopes()
            ->where('workspace_id', $workspaceId)
            ->where('user_id', $userId)
            ->where('status', MemberStatus::Active->value)
            ->exists();

        if (! $ok) {
            throw new ApiException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 422, [
                'fields' => ['assigned_to' => ['ต้องเป็นสมาชิกที่ใช้งานอยู่ของ workspace นี้']],
            ]);
        }
    }

    /**
     * API-220 — the agent queue.
     *
     * DEFAULT SORT IS ONE FORMULA FOR EVERY VIEWER (pinned decision 5 /
     * MANDATORY graft 19): `problem` first, then needs_reply
     * (last_visitor_seq > last_agent_seq), then last_message_at DESC NULLS LAST,
     * then id DESC. Ordering by recency alone buries a flagged or unanswered
     * conversation under a chatty resolved one; this triage order does the work
     * a priority field would otherwise need. The PER-AGENT read pointer NEVER
     * enters the sort — two agents must see the same queue in the same order.
     *
     * @param  array{status?: list<string>, assigned?: ?string, q?: ?string, needs_reply?: bool}  $filters
     */
    public function queue(string $workspaceId, string $viewerId, array $filters): Builder
    {
        $query = PublicChatRoom::query()
            ->where('public_chat_rooms.workspace_id', $workspaceId)
            ->with('assignedTo');

        $statuses = array_values(array_intersect($filters['status'] ?? [], PublicChatStatus::values()));
        if ($statuses !== []) {
            $query->whereIn('public_chat_rooms.status', $statuses);
        }

        $assigned = $filters['assigned'] ?? null;
        if ($assigned === 'me') {
            $query->where('public_chat_rooms.assigned_to', $viewerId);
        } elseif ($assigned === 'none') {
            $query->whereNull('public_chat_rooms.assigned_to');
        } elseif (is_string($assigned) && $assigned !== '' && $assigned !== 'all') {
            $query->where('public_chat_rooms.assigned_to', $assigned);
        }

        if (($filters['needs_reply'] ?? false) === true) {
            $query->whereColumn('public_chat_rooms.last_visitor_seq', '>', 'public_chat_rooms.last_agent_seq')
                ->where('public_chat_rooms.status', '!=', PublicChatStatus::Done->value);
        }

        $q = trim((string) ($filters['q'] ?? ''));
        if ($q !== '') {
            // MANDATORY graft 2 — "all support can see all room + message" means
            // finding a room by WHAT THE CUSTOMER ACTUALLY SAID, not only by the
            // three name columns. The EXISTS subquery is served by
            // public_chat_messages_body_trgm_idx (GIN gin_trgm_ops); without
            // that index this ILIKE is a sequential scan.
            $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%';

            $query->where(function (Builder $outer) use ($like, $workspaceId): void {
                $outer->where('public_chat_rooms.customer_name', 'ILIKE', $like)
                    ->orWhere('public_chat_rooms.provider_name', 'ILIKE', $like)
                    ->orWhere('public_chat_rooms.external_ref', 'ILIKE', $like)
                    ->orWhereExists(function ($sub) use ($like, $workspaceId): void {
                        $sub->selectRaw('1')
                            ->from('public_chat_messages')
                            ->whereColumn('public_chat_messages.room_id', 'public_chat_rooms.id')
                            ->where('public_chat_messages.workspace_id', $workspaceId)
                            ->whereNull('public_chat_messages.deleted_at')
                            ->where('public_chat_messages.body', 'ILIKE', $like);
                    });
            });
        }

        return $query
            ->orderByRaw('case when public_chat_rooms.status = ? then 0 else 1 end', [PublicChatStatus::Problem->value])
            ->orderByRaw('case when public_chat_rooms.last_visitor_seq > public_chat_rooms.last_agent_seq and public_chat_rooms.status <> ? then 0 else 1 end', [PublicChatStatus::Done->value])
            ->orderByRaw('public_chat_rooms.last_message_at desc nulls last')
            ->orderByDesc('public_chat_rooms.id');
    }

    /**
     * API-227 — the rail badge (FR-PCHAT-003). `new` + `problem` is what the
     * badge shows; `mine` drives the "assigned to me" chip.
     *
     * @return array{new: int, in_progress: int, problem: int, done: int, mine: int, needs_reply: int}
     */
    public function summary(string $workspaceId, string $viewerId): array
    {
        $rows = PublicChatRoom::query()
            ->where('workspace_id', $workspaceId)
            ->selectRaw('status, count(*) as total')
            ->groupBy('status')
            ->pluck('total', 'status');

        $mine = PublicChatRoom::query()
            ->where('workspace_id', $workspaceId)
            ->where('assigned_to', $viewerId)
            ->where('status', '!=', PublicChatStatus::Done->value)
            ->count();

        $needsReply = PublicChatRoom::query()
            ->where('workspace_id', $workspaceId)
            ->whereColumn('last_visitor_seq', '>', 'last_agent_seq')
            ->where('status', '!=', PublicChatStatus::Done->value)
            ->count();

        return [
            'new' => (int) ($rows[PublicChatStatus::New->value] ?? 0),
            'in_progress' => (int) ($rows[PublicChatStatus::InProgress->value] ?? 0),
            'problem' => (int) ($rows[PublicChatStatus::Problem->value] ?? 0),
            'done' => (int) ($rows[PublicChatStatus::Done->value] ?? 0),
            'mine' => $mine,
            'needs_reply' => $needsReply,
        ];
    }

    /**
     * FR-PCHAT-014 — the ONE ingest sanitiser for every partner-supplied name.
     *
     * Strips C0/C1 control characters and the zero-width / bidi-override block
     * (U+200B–U+200F, U+202A–U+202E), collapses surrounding whitespace, and caps
     * the length. These are the characters that let a "name" hide a payload, spoof
     * a direction, or smuggle a newline into a CSV row; stripping them at ingest
     * is the only defence that is still present when the value is later rendered
     * by a template nobody has written yet. Mirrors chat-core's
     * visitorDisplayName so the server and both clients cannot drift.
     */
    public function sanitizeText(?string $value, int $max, bool $required): ?string
    {
        if ($value === null) {
            if ($required) {
                throw new ApiException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 422, [
                    'fields' => ['name' => ['ต้องระบุ']],
                ]);
            }

            return null;
        }

        $clean = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x{0080}-\x{009F}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $value) ?? '';
        $clean = trim(preg_replace('/\s+/u', ' ', $clean) ?? '');

        if ($clean === '') {
            if ($required) {
                throw new ApiException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 422, [
                    'fields' => ['name' => ['ต้องไม่ว่าง']],
                ]);
            }

            return null;
        }

        return mb_substr($clean, 0, $max);
    }
}
