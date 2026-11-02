<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * FR-PCHAT-041 — a visitor who passed the room password. Group rooms only.
 *
 * NO WorkspaceScope, deliberately: guests are only touched on the
 * unauthenticated Tier-2 path where the scope would no-op silently. Every query
 * filters room_id AND workspace_id explicitly (DEC-070).
 *
 * `token_hash` is sha256 of the opaque guest token; the token itself is returned
 * once by API-217 and never stored. It is $hidden so a stray toArray() cannot
 * ship even the hash.
 *
 * @property string $id
 * @property string $room_id
 * @property string $workspace_id
 * @property string $display_name
 */
class PublicChatGuest extends Model
{
    use HasUlid;

    protected $fillable = ['room_id', 'workspace_id', 'display_name', 'token_hash', 'last_seen_at', 'revoked_at'];

    protected $hidden = ['token_hash'];

    protected function casts(): array
    {
        return [
            'last_seen_at' => 'datetime',
            'revoked_at' => 'datetime',
        ];
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(PublicChatRoom::class, 'room_id');
    }
}
