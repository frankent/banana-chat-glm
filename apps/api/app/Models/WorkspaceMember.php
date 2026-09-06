<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\MemberStatus;
use App\Enums\WorkspaceRole;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\Pivot;

class WorkspaceMember extends Pivot
{
    use HasUlid;

    public $timestamps = true;

    protected $primaryKey = 'id'; // ULID pk; unique(workspace_id, user_id) enforced by index

    protected $table = 'workspace_members';

    protected $fillable = [
        'workspace_id',
        'user_id',
        'role',
        'status',
        'joined_at',
        'removed_at',
        'invited_by',
    ];

    protected function casts(): array
    {
        return [
            'role' => WorkspaceRole::class,
            'status' => MemberStatus::class,
            'joined_at' => 'datetime',
            'removed_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }
}
