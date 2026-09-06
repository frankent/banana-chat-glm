<?php

namespace App\Models;

use App\Enums\NotificationMode;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class RoomNotificationSetting extends Model
{
    public $timestamps = false;

    protected $primaryKey = null; // composite (user_id, room_id)

    protected $fillable = ['user_id', 'room_id', 'mode', 'muted_until'];

    protected function casts(): array
    {
        return [
            'mode' => NotificationMode::class,
            'muted_until' => 'datetime',
        ];
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class);
    }
}
