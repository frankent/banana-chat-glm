<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * §4.3 monthly rollup of ai_usage_daily (RollupAiUsage job, closes DEC-040).
 * Composite uniqueness via expression index — see the migration.
 */
class AiUsageMonthly extends Model
{
    protected $table = 'ai_usage_monthly';

    public $timestamps = false;

    public $incrementing = false;

    protected $primaryKey = null; // composite via expression index

    protected $fillable = [
        'user_id', 'workspace_id', 'month', 'messages', 'tokens_in', 'tokens_out', 'tokens_memory', 'failed', 'rolled_up_at',
    ];

    protected function casts(): array
    {
        return [
            'month' => 'date',
            'messages' => 'integer',
            'tokens_in' => 'integer',
            'tokens_out' => 'integer',
            'tokens_memory' => 'integer',
            'failed' => 'integer',
            'rolled_up_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
