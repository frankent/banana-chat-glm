<?php

namespace App\Domain\Media;

use App\Enums\AttachmentKind;
use App\Exceptions\ApiException;
use App\Models\Attachment;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * API-062 read authorization (FR-MEDIA-004, R1). Workspace scope is already
 * proven by the caller (Attachment's global WorkspaceScope + workspace.context
 * middleware); this adds "and can this member actually reach it" across every
 * context an attachment can be attached to. Mirrors the join shape
 * SecretAttachmentExpiry already uses for the same two room-bound contexts.
 */
class AttachmentAccess
{
    public function assertCanRead(Attachment $attachment, User $user): void
    {
        if ($attachment->uploader_id === $user->id) {
            return;
        }

        // Account-level artefact — visible to anyone who can see the user,
        // same as the username/display_name it rides alongside.
        if ($attachment->kind === AttachmentKind::Avatar) {
            return;
        }

        // FR-PCHAT Tier 3 Decision A — any active workspace member already has
        // full read access to every public chat room; workspace.context
        // proved membership and there is no room-level role here.
        if ($attachment->public_chat_room_id !== null) {
            return;
        }

        // DEC-055 — Kanban ticket images are intentionally workspace-wide.
        if (DB::table('kanban_ticket_attachments')->where('attachment_id', $attachment->id)->exists()) {
            return;
        }

        if ($this->memberOfLinkedRoom($attachment, $user->id)) {
            return;
        }

        throw ApiException::mediaForbidden();
    }

    /**
     * True when the caller is a current (non-left) member of a room this
     * attachment is attached to via a message or a room note.
     */
    private function memberOfLinkedRoom(Attachment $attachment, string $userId): bool
    {
        return DB::table('room_members')
            ->where('room_members.user_id', $userId)
            ->whereNull('room_members.left_at')
            ->where(fn ($q) => $q
                ->whereIn('room_members.room_id', fn ($sub) => $sub->select('messages.room_id')
                    ->from('messages')
                    ->join('message_attachments', 'message_attachments.message_id', '=', 'messages.id')
                    ->where('message_attachments.attachment_id', $attachment->id))
                ->orWhereIn('room_members.room_id', fn ($sub) => $sub->select('room_notes.room_id')
                    ->from('room_notes')
                    ->join('room_note_attachments', 'room_note_attachments.room_note_id', '=', 'room_notes.id')
                    ->where('room_note_attachments.attachment_id', $attachment->id)))
            ->exists();
    }
}
