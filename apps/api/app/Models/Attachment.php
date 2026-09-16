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
        // FR-PCHAT-020 / DEC-068 — the partition column. NULL for every internal
        // upload; the owning public chat room for a visitor or agent support
        // ticket. It is fillable so UploadService::createForPublicChat can mass
        // assign it in the same create() as every other column; the
        // `attachments_owner_chk` CHECK keeps "owned by nobody" unrepresentable.
        'public_chat_room_id',
        'kind',
        'status',
        'original_name',
        'mime_type',
        'size_bytes',
        'storage_key',
        'checksum_sha256',
        'scan_result',
        'multipart_upload_id',
        'multipart_part_bytes',
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

    /** FR-PCHAT-020 — null for every internal attachment. */
    public function publicChatRoom(): BelongsTo
    {
        return $this->belongsTo(PublicChatRoom::class);
    }

    public function messages(): BelongsToMany
    {
        return $this->belongsToMany(Message::class, 'message_attachments', 'attachment_id', 'message_id')
            ->withPivot('position');
    }
}
