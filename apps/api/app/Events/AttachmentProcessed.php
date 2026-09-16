<?php

namespace App\Events;

use App\Enums\AttachmentStatus;
use App\Models\Attachment;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;

/**
 * EVT-030 — attachment.ready / attachment.failed on private-user.{uploader}.
 *
 * EVT-084 / FR-PCHAT-020 — an attachment partitioned to a public chat room has
 * no uploader channel to speak of: a visitor upload's uploader_id is NULL by
 * design, so the historical `new PrivateChannel('user.'.$uploader_id)` produced
 * the literal channel `private-user.` — a live, subscribable channel belonging
 * to nobody — and the visitor's own image or video thumbnail never finished
 * until they reloaded the page. These rows broadcast on the two room channels
 * instead, under the public_chat.* event name, and NEVER on private-user.
 * TC-PCHAT-023.
 */
class AttachmentProcessed extends RealtimeEvent
{
    public function __construct(
        public readonly Attachment $attachment,
    ) {}

    public function eventName(): string
    {
        $ready = $this->attachment->status === AttachmentStatus::Ready;

        if ($this->attachment->public_chat_room_id !== null) {
            return $ready ? 'public_chat.attachment.ready' : 'public_chat.attachment.failed';
        }

        return $ready ? 'attachment.ready' : 'attachment.failed';
    }

    /** @return array<int, Channel> */
    public function channels(): array
    {
        // EVT-084 — the public chat branch comes FIRST and is exclusive: an
        // agent's support ticket has a real uploader_id, and routing it to the
        // uploader as well would publish a customer conversation's attachment
        // onto an internal channel. The payload below is already a whitelist
        // with no uploader in it, safe for the visitor-facing channel.
        $roomId = $this->attachment->public_chat_room_id;

        if ($roomId !== null) {
            return [
                new PrivateChannel('public-chat.'.$roomId),
                new PrivateChannel('public-chat-staff.'.$roomId),
            ];
        }

        // Belt and braces for the invariant the `attachments_owner_chk` CHECK
        // already enforces at the database level: with both owner columns NULL
        // there is no addressee, and emitting `private-user.` with an empty id
        // would mint a subscribable cross-tenant channel. Broadcasting an empty
        // channel list is a no-op (BroadcastEvent::handle returns early on
        // `empty($channels)`), so this drops the event rather than misdirecting it.
        if ($this->attachment->uploader_id === null) {
            return [];
        }

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
