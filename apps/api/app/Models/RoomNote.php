<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;

class RoomNote extends Model
{
    use HasUlid;

    protected $guarded = [];

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    public function attachments()
    {
        return $this->belongsToMany(Attachment::class, 'room_note_attachments');
    }

    public function author()
    {
        return $this->belongsTo(User::class, 'author_id');
    }
}
