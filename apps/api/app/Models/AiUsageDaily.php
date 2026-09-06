<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class AiUsageDaily extends Model
{
    use HasUlid;

    protected $table = 'ai_usage_daily'; // avoid "dailies" pluralization

    protected $fillable = ['user_id', 'workspace_id', 'date', 'requests', 'tokens_in', 'tokens_out'];

    protected function casts(): array
    {
        return [
            'date' => 'date',
            'requests' => 'integer',
            'tokens_in' => 'integer',
            'tokens_out' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
