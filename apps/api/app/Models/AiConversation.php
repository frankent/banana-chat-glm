<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * §4.2 `ai_conversations` — user-owned, not workspace-bound (DEC-015).
 */
class AiConversation extends Model
{
    use HasUlid;

    protected $fillable = [
        'user_id', 'title', 'title_source', 'summary', 'summary_up_to_seq', 'summary_tokens',
        'token_ratio', 'last_seq', 'message_count', 'total_tokens_in', 'total_tokens_out',
        'last_message_at', 'archived_at', 'deleted_at', 'purge_after',
    ];

    protected function casts(): array
    {
        return [
            'summary_up_to_seq' => 'integer',
            'summary_tokens' => 'integer',
            'token_ratio' => 'float',
            'last_seq' => 'integer',
            'message_count' => 'integer',
            'total_tokens_in' => 'integer',
            'total_tokens_out' => 'integer',
            'last_message_at' => 'datetime',
            'archived_at' => 'datetime',
            'deleted_at' => 'datetime',
            'purge_after' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function messages(): HasMany
    {
        return $this->hasMany(AiMessage::class, 'conversation_id');
    }

    public function scopeNotDeleted(Builder $query): Builder
    {
        return $query->whereNull('deleted_at');
    }
}
