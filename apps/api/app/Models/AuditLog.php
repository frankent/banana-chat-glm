<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\ActorType;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class AuditLog extends Model
{
    use HasUlid;

    public $timestamps = false; // append-only: created_at only

    protected $fillable = [
        'workspace_id',
        'actor_id',
        'actor_type',
        'action',
        'target_type',
        'target_id',
        'context',
        'ip',
        'created_at',
    ];

    protected function casts(): array
    {
        return [
            'actor_type' => ActorType::class,
            'context' => 'array',
            'created_at' => 'datetime',
        ];
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_id');
    }

    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }
}
