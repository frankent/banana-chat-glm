<?php

namespace App\Domain\Admin;

use App\Domain\Auth\TokenService;
use App\Domain\Message\MessageEditor;
use App\Enums\UserStatus;
use App\Events\RoomCreated;
use App\Events\RoomDeleted;
use App\Events\RoomToolEvent;
use App\Events\SessionRevoked;
use App\Jobs\PurgeAttachmentFiles;
use App\Models\Attachment;
use App\Models\ChatSession;
use App\Models\Device;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomNote;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/** FR-ADM-007/011/012: audited admin actions, preserving normal realtime contracts. */
class ModerationService
{
    public function authorize(User $actor): void
    {
        if (! $actor->is_system_admin || $actor->status !== UserStatus::Active) {
            throw new AuthorizationException;
        }
    }

    public function audit(User $actor, string $action, $record): void
    {
        $this->authorize($actor);
        app(AuditLogger::class)->log($action, $actor, $record->getTable(), $record->id, [], $record->workspace_id);
    }

    public function deleteRoom(User $actor, Room $room): void
    {
        $this->authorize($actor);
        DB::transaction(function () use ($actor, $room) {
            $room = Room::query()->lockForUpdate()->findOrFail($room->id);
            if ($room->deleted_at) {
                return;
            }
            $ids = $room->members()->pluck('users.id')->all();
            $room->forceFill(['deleted_at' => now(), 'purge_after' => now()->addDays(app(SettingsService::class)->int('room.deleted_purge_days'))])->save();
            $this->audit($actor, 'room.deleted_admin', $room);
            DB::afterCommit(fn () => broadcast(new RoomDeleted($room, $ids)));
        });
    }

    public function restoreRoom(User $actor, Room $room): void
    {
        $this->authorize($actor);
        DB::transaction(function () use ($actor, $room) {
            $room = Room::query()->lockForUpdate()->findOrFail($room->id);
            if (! $room->deleted_at) {
                return;
            }
            if (! $room->purge_after || $room->purge_after->isPast()) {
                throw ValidationException::withMessages(['room' => 'The recovery window has expired.']);
            }
            $room->forceFill(['deleted_at' => null, 'purge_after' => null])->save();
            $this->audit($actor, 'room.restored', $room);
            DB::afterCommit(fn () => broadcast(new RoomCreated($room)));
        });
    }

    public function deleteMessage(User $actor, Message $message): void
    {
        $this->authorize($actor);
        app(MessageEditor::class)->delete($message, $actor, 'moderator');
    }

    public function deleteNote(User $actor, RoomNote $note): void
    {
        $this->authorize($actor);
        DB::transaction(function () use ($actor, $note) {
            $room = Room::findOrFail($note->room_id);
            $ids = $note->attachments()->pluck('attachments.id')->all();
            $this->audit($actor, 'room.note_deleted_admin', $note);
            Attachment::whereIn('id', $ids)->update(['deleted_at' => now()]);
            $note->attachments()->detach();
            $note->delete();
            if ($ids) {
                PurgeAttachmentFiles::dispatch($ids)->delay(now()->addDay());
            }
            DB::afterCommit(fn () => broadcast(new RoomToolEvent($room, 'room.notes_changed')));
        });
    }

    public function revokeSession(User $actor, ChatSession $session): void
    {
        $this->authorize($actor);
        DB::transaction(function () use ($actor, $session) {
            app(TokenService::class)->revokeSession($session, 'admin', false);
            $this->audit($actor, 'session.revoked_admin', $session);
            DB::afterCommit(fn () => broadcast(new SessionRevoked($session->user_id, $session->id, 'admin')));
        });
    }

    public function revokeDevice(User $actor, Device $device): void
    {
        $this->authorize($actor);
        DB::transaction(function () use ($actor, $device) {
            foreach ($device->sessions()->whereNull('revoked_at')->get() as $session) {
                $this->revokeSession($actor, $session);
            }
            $device->update(['push_token' => null, 'push_disabled_at' => now(), 'focused_room_id' => null, 'focused_at' => null]);
            $this->audit($actor, 'device.revoked_admin', $device);
        });
    }
}
