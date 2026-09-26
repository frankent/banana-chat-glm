<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * DEC-085 — rolling summary of a group room for the @ai bot. Built only from
 * lines the bot was already sent, never for secret rooms, and discarded when a
 * covered message is edited or deleted (the summary must not outlive it).
 */
class AiRoomSummary extends Model
{
    protected $primaryKey = 'room_id';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['room_id', 'summary', 'from_seq', 'up_to_seq', 'summary_tokens', 'source_read_at'];

    protected function casts(): array
    {
        return [
            'from_seq' => 'integer',
            'up_to_seq' => 'integer',
            'summary_tokens' => 'integer',
            'source_read_at' => 'datetime',
        ];
    }

    /** A covered message changed — the summary may still quote what it said. */
    public static function forgetCovering(string $roomId, int $seq): void
    {
        static::query()->where('room_id', $roomId)->where('from_seq', '<=', $seq)->where('up_to_seq', '>=', $seq)->delete();
    }
}
