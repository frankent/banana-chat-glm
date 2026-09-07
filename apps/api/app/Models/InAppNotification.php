<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * FR-NOTI-006 — in-app notification center rows (mention, added to room,
 * session revoked). Not a message store — entries are event pointers.
 */
class InAppNotification extends Model
{
    use HasUlid;

    protected $fillable = [
        'user_id',
        'workspace_id',
        'type',
        'room_id',
        'actor_id',
        'data',
        'read_at',
    ];

    protected $attributes = [
        'data' => '[]',
    ];

    protected function casts(): array
    {
        return [
            'data' => 'array',
            'read_at' => 'datetime',
        ];
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class);
    }

    /** API-073 row shape */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'type' => $this->type,
            'workspace_id' => $this->workspace_id,
            'room_id' => $this->room_id,
            'actor' => $this->relationLoaded('actor') && $this->actor !== null ? [
                'id' => $this->actor->id,
                'username' => $this->actor->username,
                'display_name' => $this->actor->display_name,
            ] : null,
            'data' => $this->data,
            'read_at' => $this->read_at?->toIso8601String(),
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
