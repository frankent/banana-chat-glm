<?php

namespace App\Models;

use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

/**
 * FR-PCHAT-010 / MANDATORY graft 15 — the per-agent read pointer.
 *
 * There are no room_members rows in this bounded context, so without this table
 * an agent can only be told "this room is waiting on us" (needs_reply), never
 * "I have 3 unread here". This is a two-column pointer, far cheaper than the
 * lazy room_members materialisation the rejected designs needed, and it carries
 * none of that design's fan-out cost.
 *
 * API-228 writes it MONOTONICALLY: a lower seq is a no-op, never a rewind.
 * The pointer NEVER affects queue order — the queue formula is
 * problem -> needs_reply -> last_message_at DESC NULLS LAST -> id DESC for
 * every viewer, identically (pinned decision 5).
 *
 * COMPOSITE PRIMARY KEY (room_id, user_id). Eloquent cannot express one:
 * ->find(), ->save() on a fetched row and ->delete() all assume a single key
 * column and will misbehave. Read through the query builder or this model's
 * scopes, and WRITE ONLY through markRead() below, which is an upsert.
 *
 * DEC-070 — WorkspaceScope is applied (protective on Tier 3, where this table
 * is only ever touched); workspace_id is denormalised here too so a read-pointer
 * query cannot cross tenants either.
 *
 * @property string $room_id
 * @property string $user_id
 * @property string $workspace_id
 * @property int $last_read_seq
 */
class PublicChatRead extends Model
{
    public $incrementing = false;

    public $timestamps = false;

    protected $table = 'public_chat_reads';

    /** No usable single-column key — see the class docblock. */
    protected $primaryKey = null;

    protected $keyType = 'string';

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'room_id',
        'user_id',
        'workspace_id',
        'last_read_seq',
        'last_read_at',
    ];

    protected function casts(): array
    {
        return [
            'last_read_seq' => 'integer',
            'last_read_at' => 'datetime',
        ];
    }

    /**
     * API-228 — monotonic upsert of one agent's pointer. Returns the pointer
     * value in force after the write, so a lower `$seq` reports the existing
     * (higher) value rather than pretending it moved.
     *
     * The GREATEST() in the conflict target is what makes "lower seq is a
     * no-op" a database guarantee rather than a read-modify-write race between
     * two tabs of the same agent.
     */
    public static function markRead(string $roomId, string $userId, string $workspaceId, int $seq): int
    {
        DB::statement(
            'INSERT INTO public_chat_reads (room_id, user_id, workspace_id, last_read_seq, last_read_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (room_id, user_id) DO UPDATE
               SET last_read_seq = GREATEST(public_chat_reads.last_read_seq, EXCLUDED.last_read_seq),
                   last_read_at  = EXCLUDED.last_read_at,
                   workspace_id  = EXCLUDED.workspace_id',
            [$roomId, $userId, $workspaceId, max(0, $seq), now()],
        );

        return (int) DB::table('public_chat_reads')
            ->where('room_id', $roomId)
            ->where('user_id', $userId)
            ->where('workspace_id', $workspaceId)
            ->value('last_read_seq');
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(PublicChatRoom::class, 'room_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
