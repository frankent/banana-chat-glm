<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class KanbanComment extends Model
{
    use HasUlid;

    protected $table = 'kanban_comments';

    protected $fillable = ['ticket_id', 'author_id', 'body'];

    protected function casts(): array
    {
        return [];
    }

    public function author()
    {
        return $this->belongsTo(User::class, 'author_id');
    }
}
