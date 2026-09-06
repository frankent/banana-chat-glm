<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\MessageType;
use App\Models\Scopes\WorkspaceScope;
use Database\Factories\MessageFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Message extends Model
{
    /** @use HasFactory<MessageFactory> */
    use HasFactory, HasUlid;

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'room_id',
        'workspace_id',
        'sender_id',
        'seq',
        'type',
        'body',
        'client_message_id',
        'reply_to_message_id',
        'system_event',
        'metadata',
    ];

    protected function casts(): array
    {
        return [
            'type' => MessageType::class,
            'seq' => 'integer',
            'system_event' => 'array',
            'metadata' => 'array',
            'edited_at' => 'datetime',
            'edit_count' => 'integer',
            'deleted_at' => 'datetime',
        ];
    }

    public function room(): BelongsTo
    {
        return $this->belongsTo(Room::class);
    }

    public function sender(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function replyTo(): BelongsTo
    {
        return $this->belongsTo(Message::class, 'reply_to_message_id');
    }

    public function mentions(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'message_mentions', 'message_id', 'user_id')
            ->withPivot('workspace_id'); // table has no timestamps
    }

    public function reactions(): HasMany
    {
        return $this->hasMany(MessageReaction::class);
    }

    public function edits(): HasMany
    {
        return $this->hasMany(MessageEdit::class);
    }

    public function attachments(): BelongsToMany
    {
        return $this->belongsToMany(Attachment::class, 'message_attachments', 'message_id', 'attachment_id')
            ->withPivot('position');
    }
}
