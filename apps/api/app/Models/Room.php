<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\RoomType;
use App\Models\Scopes\WorkspaceScope;
use Database\Factories\RoomFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Room extends Model
{
    /** @use HasFactory<RoomFactory> */
    use HasFactory, HasUlid;

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'workspace_id',
        'type',
        'name',
        'description',
        'dm_key',
        'created_by',
        'owner_id',
        'settings',
        'member_count', // denormalized counter, maintained by Domain actions only
        'last_message_at',
    ];

    protected function casts(): array
    {
        return [
            'type' => RoomType::class,
            'settings' => 'array',
            'last_seq' => 'integer',
            'last_user_seq' => 'integer',
            'last_message_at' => 'datetime',
            'member_count' => 'integer',
            'purge_after' => 'datetime',
            'deleted_at' => 'datetime',
        ];
    }

    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }

    public function members(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'room_members', 'room_id', 'user_id')
            ->withPivot(['workspace_id', 'role', 'last_read_seq', 'last_read_at', 'joined_at', 'left_at', 'hidden_at', 'pinned_at', 'added_by'])
            ->using(RoomMember::class)
            ->wherePivotNull('left_at')
            ->withTimestamps();
    }

    public function memberships(): HasMany
    {
        return $this->hasMany(RoomMember::class);
    }

    public function messages(): HasMany
    {
        return $this->hasMany(Message::class);
    }

    public function lastMessage(): BelongsTo
    {
        return $this->belongsTo(Message::class, 'last_message_id');
    }

    public function isDm(): bool
    {
        return $this->type === RoomType::Dm;
    }
}
