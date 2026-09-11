<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class RoomCall extends Model
{
    use HasUlid;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['connected_at' => 'datetime', 'ended_at' => 'datetime'];
    }
}
