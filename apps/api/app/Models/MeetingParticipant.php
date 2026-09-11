<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class MeetingParticipant extends Model
{
    use HasUlid;

    protected $guarded = [];

    protected $hidden = ['token_hash'];

    protected function casts(): array
    {
        return ['left_at' => 'datetime'];
    }
}
