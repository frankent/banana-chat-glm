<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Attachment extends Model
{
    use HasUlid;

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'workspace_id',
        'uploader_id',
        'kind',
        'status',
        'original_name',
        'mime_type',
        'size_bytes',
        'storage_key',
        'checksum_sha256',
        'width',
        'height',
        'duration_ms',
        'derived',
        'expires_at',
        'deleted_at',
    ];

    protected function casts(): array
    {
        return [
            'kind' => AttachmentKind::class,
            'status' => AttachmentStatus::class,
            'size_bytes' => 'integer',
            'width' => 'integer',
            'height' => 'integer',
            'duration_ms' => 'integer',
            'derived' => 'array',
            'expires_at' => 'datetime',
            'deleted_at' => 'datetime',
        ];
    }

    public function uploader(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function messages(): BelongsToMany
    {
        return $this->belongsToMany(Message::class, 'message_attachments', 'attachment_id', 'message_id')
            ->withPivot('position');
    }
}
