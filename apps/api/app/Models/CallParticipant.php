<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class CallParticipant extends Model
{
    use HasUlid;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['left_at' => 'datetime'];
    }
}
