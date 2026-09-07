<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * §4.2 `ai_messages` — content null while pending/streaming (stream lives
 * in the Redis buffer `ai:gen:{id}`).
 */
class AiMessage extends Model
{
    use HasUlid;

    protected $fillable = [
        'conversation_id', 'user_id', 'workspace_id', 'seq', 'role', 'content', 'status',
        'error_code', 'error_detail', 'client_message_id', 'parent_message_id', 'superseded_at',
        'model', 'finish_reason', 'tokens_prompt', 'tokens_completion', 'tokens_source',
        'latency_first_token_ms', 'latency_total_ms', 'attachments', 'started_at', 'completed_at',
    ];

    protected function casts(): array
    {
        return [
            'seq' => 'integer',
            'attachments' => 'array',
            'superseded_at' => 'datetime',
            'tokens_prompt' => 'integer',
            'tokens_completion' => 'integer',
            'latency_first_token_ms' => 'integer',
            'latency_total_ms' => 'integer',
            'started_at' => 'datetime',
            'completed_at' => 'datetime',
        ];
    }

    public function conversation(): BelongsTo
    {
        return $this->belongsTo(AiConversation::class, 'conversation_id');
    }
}
