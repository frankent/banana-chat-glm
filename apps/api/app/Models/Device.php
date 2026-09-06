<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\DevicePlatform;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Device extends Model
{
    use HasUlid;

    protected $fillable = [
        'user_id',
        'platform',
        'push_token',
        'push_provider',
        'app_version',
        'device_name',
        'locale',
        'last_active_at',
        'push_failed_count',
        'push_disabled_at',
    ];

    protected $hidden = ['push_token'];

    protected function casts(): array
    {
        return [
            'platform' => DevicePlatform::class,
            'last_active_at' => 'datetime',
            'push_failed_count' => 'integer',
            'push_disabled_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function sessions(): HasMany
    {
        return $this->hasMany(ChatSession::class);
    }
}
