<?php

namespace App\Jobs;

use App\Domain\Calls\CallService;
use App\Events\RoomDeleted;
use App\Models\Attachment;
use App\Models\Room;
use App\Models\RoomCall;
use App\Services\AuditLogger;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * FR-ROOM-012 / DEC-056 — purge expired secret rooms through the existing
 * deletion lifecycle: members get EVT room.deleted (clients evict the room
 * and purge local caches), attachments are unlinked and their objects queue
 * for immediate file deletion (no 24h/moderator window — secret content must
 * not linger), active calls are revoked, and the audit trail records the
 * system action. Ordinary rooms are never touched.
 *
 * Soft-deleted secret rooms (admin moderation) are swept too: their content
 * must not outlive the secret deadline even though the 30-day recovery
 * window would otherwise keep it — expiry outranks recovery for secret rooms.
 *
 * Access denial does NOT wait for this job: RoomPolicy::membership() rejects
 * the room the moment secret_expires_at passes. The scheduler only reclaims
 * storage/rows.
 */
class ExpireSecretRooms implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries = 3;

    public int $timeout = 300;

    public function __construct(
        public readonly ?int $limit = null,
    ) {}

    public function handle(): void
    {
        Room::query()
            ->withoutGlobalScopes()
            ->where('is_secret', true)
            ->where('secret_expires_at', '<=', now())
            ->when($this->limit !== null, fn ($query) => $query->limit($this->limit))
            ->pluck('id')
            ->each(fn (string $id) => $this->expireRoom(Room::withoutGlobalScopes()->find($id)));
    }

    /**
     * Idempotent single-room expiry — also called inline when a new secret DM
     * collides with an expired row that still pins the dm_key.
     */
    public function expireRoom(?Room $room): void
    {
        if ($room === null || ! $room->isSecret() || ! $room->isExpired()) {
            return;
        }

        try {
            $wasLive = $room->deleted_at === null;
            $memberIds = $room->memberships()->whereNull('left_at')->pluck('user_id')->all();

            // revoke any live call first. CallService::end persists the
            // revocation BEFORE touching the SFU, so an SFU outage cannot
            // block the room purge — report it and let ReconcileCalls retry
            // the server-side teardown of any residue.
            foreach (RoomCall::query()->where('room_id', $room->id)->whereNull('ended_at')->get() as $call) {
                try {
                    app(CallService::class)->end($call);
                } catch (Throwable $e) {
                    report($e);
                }
            }

            $attachmentIds = DB::transaction(function () use ($room, $wasLive, $memberIds): array {
                /** @var Room $locked */
                $locked = Room::withoutGlobalScopes()->lockForUpdate()->find($room->id);

                if ($locked === null || ! $locked->isSecret() || ! $locked->isExpired()) {
                    return []; // swept by a concurrent run
                }

                $messageAttachmentIds = DB::table('message_attachments')
                    ->join('messages', 'messages.id', '=', 'message_attachments.message_id')
                    ->where('messages.room_id', $locked->id)
                    ->pluck('attachment_id')
                    ->all();
                $noteAttachmentIds = DB::table('room_note_attachments')
                    ->join('room_notes', 'room_notes.id', '=', 'room_note_attachments.room_note_id')
                    ->where('room_notes.room_id', $locked->id)
                    ->pluck('attachment_id')
                    ->all();

                $attachmentIds = array_values(array_unique([...$messageAttachmentIds, ...$noteAttachmentIds]));
                if ($attachmentIds !== []) {
                    Attachment::withoutGlobalScopes()
                        ->whereIn('id', $attachmentIds)
                        ->whereNull('deleted_at')
                        ->update(['deleted_at' => now()]);
                }

                app(AuditLogger::class)->system(
                    'room.secret_expired',
                    $locked->workspace_id,
                    'room',
                    $locked->id,
                    ['expires_at' => $locked->secret_expires_at?->toIso8601String()],
                );

                // FKs cascade: members, messages (+edits/mentions/reactions/
                // attachment pivots), notes, pins, calls, notification rows
                $locked->forceDelete();

                // members evict the room on every client the moment it
                // expires. Scalar snapshot survives the hard delete; fired
                // only on commit so a failed purge announces nothing.
                // Skip when the room was already soft-deleted — those
                // members received EVT-003 at moderation time.
                if ($wasLive) {
                    DB::afterCommit(fn () => broadcast(RoomDeleted::forRoom($locked, $memberIds)));
                }

                return $attachmentIds;
            });

            if ($attachmentIds !== []) {
                // no delay — the 24h moderator-recovery window does not apply
                PurgeAttachmentFiles::dispatch($attachmentIds)->afterCommit();
            }
        } catch (Throwable $e) {
            report($e);

            // Swallowing the failure here would let a synchronous inline call
            // (secret-DM dm_key reclamation) pretend the room was purged and
            // then die on the unique constraint. Retry only on a real queue.
            if ($this->job !== null) {
                $this->release(60);

                return;
            }

            throw $e;
        }
    }
}
