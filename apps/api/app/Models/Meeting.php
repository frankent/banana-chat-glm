<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class Meeting extends Model
{
    use HasUlid;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['expires_at' => 'datetime', 'ended_at' => 'datetime'];
    }
}
