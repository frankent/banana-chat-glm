<?php

namespace App\Events;

use App\Enums\AttachmentStatus;
use App\Models\Attachment;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * EVT-030 — attachment.ready / attachment.failed on private-user.{uploader}.
 */
class AttachmentProcessed extends RealtimeEvent
{
    public function __construct(
        public readonly Attachment $attachment,
    ) {}

    public function eventName(): string
    {
        return $this->attachment->status === AttachmentStatus::Ready
            ? 'attachment.ready'
            : 'attachment.failed';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        return [new PrivateChannel('user.'.$this->attachment->uploader_id)];
    }

    protected function workspaceId(): ?string
    {
        return $this->attachment->workspace_id;
    }

    /**
     * @return array<string, mixed>
     */
    protected function payload(): array
    {
        return [
            'attachment' => [
                'attachment_id' => $this->attachment->id,
                'kind' => $this->attachment->kind->value,
                'status' => $this->attachment->status->value,
                'filename' => $this->attachment->original_name,
                'width' => $this->attachment->width,
                'height' => $this->attachment->height,
            ],
        ];
    }
}
