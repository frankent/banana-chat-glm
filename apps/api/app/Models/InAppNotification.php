<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Domain\Notification\PushDecisionService;
use App\Enums\UserStatus;
use App\Events\NotificationAlert;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * FR-NOTI-006 — in-app notification center rows (mention, added to room,
 * session revoked). Not a message store — entries are event pointers.
 */
class InAppNotification extends Model
{
    use HasUlid;

    protected $fillable = [
        'user_id',
        'workspace_id',
        'type',
        'room_id',
        'actor_id',
        'data',
        'read_at',
    ];

    protected $attributes = [
        'data' => '[]',
    ];

    protected static function booted(): void
    {
        static::created(function (self $notification): void {
            // Mentions already receive the message alert; never double-ring.
            if ($notification->type === 'mention' || $notification->actor_id === $notification->user_id) {
                return;
            }
            $user = User::find($notification->user_id);
            if ($user === null || $user->status !== UserStatus::Active) {
                return;
            }
            $setting = $user->notificationSetting;
            if (! ($setting?->sound ?? true) || app(PushDecisionService::class)->inDnd($setting, $user->timezone)) {
                return;
            }
            broadcast(new NotificationAlert($user->id, $notification->id, $notification->room_id, $notification->workspace_id, $notification->type));
        });
    }

    protected function casts(): array
    {
        return [
            'data' => 'array',
            'read_at' => 'datetime',
        ];
    }

    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class);
    }

    /** API-073 row shape */
    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'type' => $this->type,
            'workspace_id' => $this->workspace_id,
            'room_id' => $this->room_id,
            'actor' => $this->relationLoaded('actor') && $this->actor !== null ? [
                'id' => $this->actor->id,
                'username' => $this->actor->username,
                'display_name' => $this->actor->display_name,
            ] : null,
            'data' => $this->data,
            'read_at' => $this->read_at?->toIso8601String(),
            'created_at' => $this->created_at?->toIso8601String(),
        ];
    }
}
