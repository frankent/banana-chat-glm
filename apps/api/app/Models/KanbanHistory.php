<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class KanbanHistory extends Model
{
    use HasUlid;

    protected $table = 'kanban_history';

    protected $fillable = ['ticket_id', 'actor_id', 'changes'];

    protected function casts(): array
    {
        return ['changes' => 'array'];
    }

    public function actor()
    {
        return $this->belongsTo(User::class, 'actor_id');
    }
}
