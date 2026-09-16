<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatSystemEvent;
use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Support\Str;

/**
 * FR-PCHAT-002 — one row of a customer transcript. Not a `messages` row.
 *
 * ==== WORKSPACE ISOLATION (DEC-070) — same contract as PublicChatRoom ======
 * WorkspaceScope IS applied: protective on Tier 3 where workspace.context is
 * set, INERT on Tier 1/Tier 2 where no context exists (WorkspaceScope::apply()
 * no-ops silently, Models/Scopes/WorkspaceScope.php:20). Every Tier-1 and
 * Tier-2 query MUST ALSO filter workspace_id explicitly. workspace_id is
 * denormalised onto this table for exactly that reason: even a wrong room_id
 * join cannot cross tenants when workspace_id is in the WHERE too.
 * ===========================================================================
 *
 * WHY THE SNAPSHOT COLUMNS EXIST. The public serializer computes the external
 * display name as "{provider_name_snapshot} ({agent_username_snapshot})" and
 * NEVER joins `users`. Two consequences, both intended: a later username change
 * or provider rename does not retroactively rewrite the customer's transcript,
 * and a buggy join cannot leak a user row onto the public surface. Do not
 * "simplify" the serializer by dereferencing senderUser().
 *
 * `sender_kind` is ALWAYS set server-side from the authenticated tier and NEVER
 * from the request payload — Tier 2 has no code path that can write 'agent'.
 *
 * IDEMPOTENCY (DEC-066 / graft 13 / pinned decision 4). The unique is
 * (room_id, sender_kind, client_message_id), all three NOT NULL. sender_kind is
 * part of the key so a visitor — who supplies a free-form id — cannot squat an
 * agent's client_message_id and have the agent's send silently return the
 * visitor's row as a 200 replay. Visitor ids must be UUID (422 otherwise),
 * agent ids are crypto.randomUUID(), and SYSTEM ROWS GET A SERVER-GENERATED
 * ULID via newSystemClientId() — they have no client, and the column is NOT
 * NULL, so without one the first status change violates the constraint.
 *
 * @property string $id
 * @property string $room_id
 * @property string $workspace_id
 * @property int $seq
 * @property PublicChatSenderKind $sender_kind
 * @property ?string $sender_user_id
 * @property PublicChatMessageType $type
 * @property ?string $body
 * @property ?PublicChatSystemEvent $system_event
 * @property ?array $system_meta
 */
class PublicChatMessage extends Model
{
    use HasUlid;

    /** Append-only transcript: rows are created, soft-deleted, never updated. */
    public const UPDATED_AT = null;

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'room_id',
        'workspace_id',
        'seq',
        'sender_kind',
        'sender_user_id',
        'agent_username_snapshot',
        'provider_name_snapshot',
        'type',
        'body',
        'system_event',
        'system_meta',
        'reply_to_message_id',
        'client_message_id',
        'deleted_at',
        'deleted_by',
    ];

    protected function casts(): array
    {
        return [
            'seq' => 'integer',
            'sender_kind' => PublicChatSenderKind::class,
            'type' => PublicChatMessageType::class,
            'system_event' => PublicChatSystemEvent::class,
            'system_meta' => 'array',
            'created_at' => 'datetime',
            'deleted_at' => 'datetime',
        ];
    }

    /**
     * MANDATORY graft 11 — system rows have no client, but client_message_id is
     * NOT NULL and part of the idempotency unique. Server-generated ULID.
     */
    public static function newSystemClientId(): string
    {
        return strtolower((string) Str::ulid());
    }

    public function isDeleted(): bool
    {
        return $this->deleted_at !== null;
    }

    /**
     * FR-PCHAT-014 — the external display name, assembled from write-time
     * snapshots only. Rendered as a PLAIN TEXT node on every surface: it is
     * partner-supplied and must never reach parseMarkdown, a Filament
     * ->html() column, or a blade {!! !!}.
     */
    public function externalDisplayName(): ?string
    {
        if ($this->sender_kind !== PublicChatSenderKind::Agent) {
            return null;
        }

        $provider = (string) $this->provider_name_snapshot;
        $username = (string) $this->agent_username_snapshot;

        return $username === '' ? $provider : $provider.' ('.$username.')';
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(PublicChatRoom::class, 'room_id');
    }

    /**
     * STAFF SURFACES ONLY. The public serializer must never touch this relation
     * — that is what the *_snapshot columns are for.
     */
    public function senderUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'sender_user_id');
    }

    public function deletedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'deleted_by');
    }

    public function replyTo(): BelongsTo
    {
        return $this->belongsTo(self::class, 'reply_to_message_id');
    }

    public function attachments(): BelongsToMany
    {
        return $this->belongsToMany(
            Attachment::class,
            'public_chat_message_attachments',
            'message_id',
            'attachment_id',
        )->withPivot('position')->orderBy('public_chat_message_attachments.position');
    }
}
