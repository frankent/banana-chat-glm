<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\RoomRole;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\Pivot;

class RoomMember extends Pivot
{
    use HasUlid;

    public $timestamps = true;

    protected $primaryKey = 'id'; // ULID pk; unique(room_id, user_id) enforced by index

    protected $table = 'room_members';

    protected $fillable = [
        'room_id',
        'user_id',
        'workspace_id',
        'role',
        'last_read_seq',
        'last_read_at',
        'joined_at',
        'left_at',
        'hidden_at',
        'pinned_at',
        'added_by',
    ];

    protected function casts(): array
    {
        return [
            'role' => RoomRole::class,
            'last_read_seq' => 'integer',
            'last_read_at' => 'datetime',
            'joined_at' => 'datetime',
            'left_at' => 'datetime',
            'hidden_at' => 'datetime',
            'pinned_at' => 'datetime',
        ];
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
