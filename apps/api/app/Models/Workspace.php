<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\MemberStatus;
use App\Enums\WorkspaceStatus;
use Database\Factories\WorkspaceFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Workspace extends Model
{
    /** @use HasFactory<WorkspaceFactory> */
    use HasFactory, HasUlid;

    protected $fillable = [
        'slug',
        'name',
        'status',
        'settings',
        'message_retention_days',
        'attachment_retention_days',
    ];

    protected function casts(): array
    {
        return [
            'status' => WorkspaceStatus::class,
            'settings' => 'array',
            'message_retention_days' => 'integer',
            'attachment_retention_days' => 'integer',
        ];
    }

    public function members(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'workspace_members', 'workspace_id', 'user_id')
            ->withPivot(['role', 'status', 'joined_at', 'removed_at', 'invited_by'])
            ->using(WorkspaceMember::class)
            ->wherePivot('status', MemberStatus::Active->value)
            ->withTimestamps();
    }

    public function allMemberships(): HasMany
    {
        return $this->hasMany(WorkspaceMember::class);
    }

    public function rooms(): HasMany
    {
        return $this->hasMany(Room::class);
    }
}
