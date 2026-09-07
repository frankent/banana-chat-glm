<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\MemberStatus;
use App\Enums\UserStatus;
use Database\Factories\UserFactory;
use Filament\Models\Contracts\FilamentUser as FilamentUserContract;
use Filament\Models\Contracts\HasName as FilamentHasNameContract;
use Filament\Panel;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

/**
 * @property string $password_hash users.password_hash (not "password")
 */
class User extends Authenticatable implements FilamentHasNameContract, FilamentUserContract
{
    /** @use HasFactory<UserFactory> */
    use HasFactory, HasUlid, Notifiable;

    /**
     * FR-ADM-001 — panel access is system-admin only (guard already filters).
     */
    public function canAccessPanel(Panel $panel): bool
    {
        return $this->is_system_admin && $this->status === UserStatus::Active;
    }

    public function getFilamentName(): string
    {
        return $this->display_name; // no `name` column — users.display_name
    }

    protected $fillable = [
        'username',
        'password_hash',
        'display_name',
        'status',
        'must_change_password',
        'password_changed_at',
        'locked_until',
        'last_seen_at',
        'locale',
        'timezone',
        'is_system_admin',
        'failed_login_count',
        'created_by',
        'totp_secret',
        'totp_enabled_at',
    ];

    protected $hidden = [
        'password_hash',
        'remember_token',
        'failed_login_count',
        'totp_secret',
    ];

    protected function casts(): array
    {
        return [
            'status' => UserStatus::class,
            'must_change_password' => 'boolean',
            'password_changed_at' => 'datetime',
            'locked_until' => 'datetime',
            'last_seen_at' => 'datetime',
            'ai_consented_at' => 'datetime',
            'ai_memory_enabled' => 'boolean',
            'totp_secret' => 'encrypted',
            'totp_enabled_at' => 'datetime',
            'is_system_admin' => 'boolean',
            'failed_login_count' => 'integer',
        ];
    }

    public function getAuthPassword(): string
    {
        return $this->password_hash; // column is password_hash, not password
    }

    public function workspaces(): BelongsToMany
    {
        return $this->belongsToMany(Workspace::class, 'workspace_members', 'user_id', 'workspace_id')
            ->withPivot(['role', 'status', 'joined_at', 'removed_at'])
            ->using(WorkspaceMember::class)
            ->wherePivot('status', MemberStatus::Active->value)
            ->withTimestamps();
    }

    public function workspaceMemberships(): HasMany
    {
        return $this->hasMany(WorkspaceMember::class);
    }

    public function sessions(): HasMany
    {
        return $this->hasMany(ChatSession::class);
    }

    public function devices(): HasMany
    {
        return $this->hasMany(Device::class);
    }

    public function accessTokens(): HasMany
    {
        return $this->hasMany(AccessToken::class);
    }

    public function notificationSetting(): HasOne
    {
        return $this->hasOne(UserNotificationSetting::class);
    }
}
