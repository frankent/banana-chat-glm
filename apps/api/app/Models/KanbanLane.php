<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class KanbanLane extends Model
{
    use HasUlid;

    protected $table = 'kanban_lanes';

    protected $fillable = ['workspace_id', 'name', 'color', 'position', 'is_done'];

    protected function casts(): array
    {
        return ['position' => 'integer', 'is_done' => 'boolean'];
    }
}
