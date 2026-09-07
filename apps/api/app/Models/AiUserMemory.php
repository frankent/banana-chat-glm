<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * §4.2 `ai_user_memories` — cross-workspace (DEC-016). User deletes are
 * hard deletes; deleted_at exists for the eviction path.
 */
class AiUserMemory extends Model
{
    use HasUlid;

    public const CATEGORIES = ['profile', 'preference', 'project', 'other'];

    protected $fillable = [
        'user_id', 'content', 'category', 'importance', 'source',
        'source_conversation_id', 'source_message_id', 'last_used_at', 'deleted_at',
    ];

    protected function casts(): array
    {
        return [
            'importance' => 'integer',
            'last_used_at' => 'datetime',
            'deleted_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function scopeActive(Builder $query): Builder
    {
        return $query->whereNull('deleted_at');
    }
}
