<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class UserNotificationSetting extends Model
{
    protected $primaryKey = 'user_id';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'user_id',
        'dnd_start',
        'dnd_end',
        'dnd_days',
        'sound',
        'preview_in_push',
    ];

    protected function casts(): array
    {
        return [
            'dnd_days' => 'array',
            'sound' => 'boolean',
            'preview_in_push' => 'boolean',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
