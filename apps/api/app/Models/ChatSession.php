<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Spec §4.2 `sessions` — login session with rotating refresh token.
 * Named ChatSession to avoid clashing with Laravel's session infrastructure.
 */
class ChatSession extends Model
{
    use HasUlid;

    protected $table = 'sessions'; // spec §4.2 table name

    protected $fillable = [
        'user_id',
        'refresh_token_hash',
        'prev_refresh_token_hash',
        'device_id',
        'ip',
        'user_agent',
        'last_used_at',
        'expires_at',
        'revoked_at',
        'revoked_reason',
    ];

    protected $hidden = ['refresh_token_hash', 'prev_refresh_token_hash'];

    protected function casts(): array
    {
        return [
            'last_used_at' => 'datetime',
            'expires_at' => 'datetime',
            'revoked_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function device(): BelongsTo
    {
        return $this->belongsTo(Device::class);
    }

    public function accessTokens(): HasMany
    {
        return $this->hasMany(AccessToken::class, 'session_id');
    }

    public function isRevoked(): bool
    {
        return $this->revoked_at !== null;
    }

    public function isExpired(): bool
    {
        return $this->expires_at->isPast();
    }

    public function isActive(): bool
    {
        return ! $this->isRevoked() && ! $this->isExpired();
    }
}
