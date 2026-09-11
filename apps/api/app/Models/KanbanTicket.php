<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;

class KanbanTicket extends Model
{
    use HasUlid;

    protected $table = 'kanban_tickets';

    protected $fillable = ['workspace_id', 'lane_id', 'number', 'title', 'description', 'type', 'priority', 'assignee_id', 'reporter_id', 'labels', 'due_at', 'due_notified_at', 'version'];

    protected function casts(): array
    {
        return ['number' => 'integer', 'version' => 'integer', 'labels' => 'array', 'due_at' => 'immutable_datetime', 'due_notified_at' => 'immutable_datetime'];
    }

    public function assignee()
    {
        return $this->belongsTo(User::class, 'assignee_id');
    }

    public function reporter()
    {
        return $this->belongsTo(User::class, 'reporter_id');
    }

    public function lane()
    {
        return $this->belongsTo(KanbanLane::class, 'lane_id');
    }
}
