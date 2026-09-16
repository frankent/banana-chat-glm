<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\PublicChatStatus;
use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * FR-PCHAT-001 — one customer conversation. NOT a `rooms` row, deliberately
 * (DEC-064): because this id does not resolve against `rooms`,
 * RoomController::index, SearchController::memberRoomIds, CallService::allowed,
 * the room.{roomId} channel callback, RoomPolicy, MessageEditor,
 * Jobs/NotifyMessage, workspaceUnread, GenerateRoomBotReply and the RoomType
 * enum are all untouched, and "no calls, no meetings, never in the room list"
 * is structural rather than a gate five independent places must remember.
 *
 * ==== WORKSPACE ISOLATION — READ BEFORE ADDING A QUERY (DEC-070) ============
 * This model DOES carry WorkspaceScope, and that is a deliberate choice, not an
 * oversight in either direction:
 *  - On TIER 3 (agents) workspace.context middleware has set WorkspaceContext,
 *    so the scope is real protection — it is what stops a bare
 *    PublicChatRoom::find($id) from returning another workspace's room.
 *  - On TIER 1 (HMAC partner) and TIER 2 (visitor, unauthenticated) the room is
 *    resolved BEFORE any workspace context exists, so the scope is INERT:
 *    WorkspaceScope::apply() no-ops silently when the context is unset
 *    (Models/Scopes/WorkspaceScope.php:20) — no exception, no log.
 * THEREFORE: every Tier-1 and Tier-2 query MUST ALSO filter workspace_id
 * explicitly, and workspace_id is denormalised onto public_chat_messages and
 * public_chat_reads so that even a wrong room_id join cannot cross tenants.
 * Neither the scope nor the explicit filter is sufficient alone. Do not remove
 * either one.
 * ===========================================================================
 *
 * `code` IS the visitor credential (DEC-063). It is bearer authority: anyone
 * holding the /support/<code> URL is the visitor. It must never appear in a
 * channel name, a query string, or an nginx access log — the realtime channels
 * are keyed by this row's ULID precisely so the code never travels in a
 * WebSocket subscribe frame.
 *
 * @property string $id
 * @property string $workspace_id
 * @property ?string $api_key_id
 * @property string $code
 * @property string $customer_name
 * @property string $provider_name
 * @property PublicChatStatus $status
 * @property ?string $assigned_to
 * @property ?array $meta
 */
class PublicChatRoom extends Model
{
    use HasUlid, SoftDeletes;

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'workspace_id',
        'api_key_id',
        'code',
        'customer_name',
        'provider_name',
        'status',
        'assigned_to',
        'claimed_at',
        'first_response_at',
        'external_ref',
        'meta',
        'locale',
        'last_seq',
        'last_visitor_seq',
        'last_agent_seq',
        'last_message_at',
        'expires_at',
        'closed_at',
    ];

    /**
     * `meta` is the partner's arbitrary payload and is NEVER served to the
     * visitor. It is hidden here so a stray ->toArray() on a Tier-2 path cannot
     * ship it; the visitor serializer whitelists fields anyway.
     *
     * `code` joins it for the same reason, one step stronger: the 64-hex code is
     * BEARER AUTHORITY (DEC-063) — whoever holds it is the visitor, for the life
     * of the room. A Tier-2 response, a broadcast payload or a log line built by
     * a stray ->toArray()/->toJson() on this model would hand that authority to
     * every reader of the transcript. Hiding it makes the failure mode "the code
     * is missing" instead of "the code leaked". The deliberate readers —
     * API-200/203's response, the /support/<code> URL builder and the Filament
     * link column — read `$room->code` as a property, which $hidden does not
     * touch; only array/JSON serialisation is affected.
     */
    protected $hidden = ['meta', 'code'];

    protected function casts(): array
    {
        return [
            'status' => PublicChatStatus::class,
            'meta' => 'array',
            'last_seq' => 'integer',
            'last_visitor_seq' => 'integer',
            'last_agent_seq' => 'integer',
            'claimed_at' => 'datetime',
            'first_response_at' => 'datetime',
            'last_message_at' => 'datetime',
            'expires_at' => 'datetime',
            'closed_at' => 'datetime',
            'deleted_at' => 'datetime',
        ];
    }

    /** bin2hex(random_bytes(32)) — 256 bits, not brute-forceable. */
    public static function generateCode(): string
    {
        return bin2hex(random_bytes(32));
    }

    public function isExpired(): bool
    {
        return $this->expires_at !== null && $this->expires_at->lessThanOrEqualTo(now());
    }

    public function isClosed(): bool
    {
        return $this->status === PublicChatStatus::Done;
    }

    /**
     * MANDATORY graft 1 / pinned decision 2 — the ONLY status value a visitor
     * ever sees. Raw `problem` must not reach the customer.
     */
    public function statusPublic(): string
    {
        return $this->status->public();
    }

    /**
     * FR-PCHAT-005 — the room is waiting on us. Room-level signal; the
     * per-agent unread pointer lives in public_chat_reads (FR-PCHAT-010).
     */
    public function needsReply(): bool
    {
        return $this->last_visitor_seq > $this->last_agent_seq
            && $this->status !== PublicChatStatus::Done;
    }

    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }

    public function apiKey(): BelongsTo
    {
        return $this->belongsTo(PublicChatApiKey::class, 'api_key_id');
    }

    public function assignedTo(): BelongsTo
    {
        return $this->belongsTo(User::class, 'assigned_to');
    }

    public function messages(): HasMany
    {
        return $this->hasMany(PublicChatMessage::class, 'room_id');
    }

    public function reads(): HasMany
    {
        return $this->hasMany(PublicChatRead::class, 'room_id');
    }

    /**
     * FR-PCHAT-020 — attachments partitioned into this room. An attachment with
     * public_chat_room_id set can ONLY be claimed by a message in that same room
     * and can NEVER be claimed by an internal message.
     */
    public function attachments(): HasMany
    {
        return $this->hasMany(Attachment::class, 'public_chat_room_id');
    }
}
