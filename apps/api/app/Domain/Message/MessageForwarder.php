<?php

namespace App\Domain\Message;

use App\Domain\Room\RoomPolicy;
use App\Enums\AttachmentStatus;
use App\Enums\MessageType;
use App\Exceptions\ApiException;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\Room;
use App\Models\User;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Support\WorkspaceContext;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;
use Throwable;

/**
 * FR-MSG-011 / DEC-083 — Telegram-style forward: every source message becomes a
 * NEW message in each target room, sent by the forwarder, carrying the original
 * author as metadata.forward. Everything is validated before the first write;
 * each target then commits on its own through MessageWriter (no transaction
 * spans rooms — several room locks taken in request order would deadlock
 * against ordinary sends).
 */
class MessageForwarder
{
    public function __construct(
        private readonly WorkspaceContext $context,
        private readonly RoomPolicy $policy,
        private readonly SettingsService $settings,
        private readonly MessageWriter $writer,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  list<string>  $messageIds
     * @param  list<string>  $roomIds
     * @return array{results: list<array{room_id: string, messages: list<Message>}>, failed_room_ids: list<string>, created: bool}
     */
    public function forward(User $actor, string $forwardId, string $sourceRoomId, array $messageIds, array $roomIds): array
    {
        $messageIds = array_values(array_unique($messageIds));
        $roomIds = array_values(array_unique($roomIds));

        if (count($messageIds) > $this->settings->int('message.forward_max_messages')) {
            throw ApiException::msgForwardInvalid('too_many_messages');
        }
        if (count($roomIds) > $this->settings->int('message.forward_max_rooms')) {
            throw ApiException::msgForwardInvalid('too_many_rooms');
        }

        $source = Room::query()
            ->where('workspace_id', $this->context->id())
            ->whereNull('deleted_at')
            ->find($sourceRoomId);
        if ($source === null) {
            abort(404);
        }

        $this->policy->membershipOrFail($source, $actor); // expired → 410, left/removed → 403

        // FR-ROOM-012 promises a secret room's content disappears at expiry
        if ($source->isSecret()) {
            throw ApiException::msgForwardInvalid('secret_source');
        }

        $messages = $this->sourceMessages($source, $messageIds);
        $targets = $this->targets($actor, $roomIds);

        $results = [];
        $failed = [];
        $created = false;
        $lastError = null;

        foreach ($targets as $target) {
            try {
                $copies = [];
                foreach ($messages as $message) {
                    [$copy, $wasCreated] = $this->forwardOne($actor, $forwardId, $message, $target);
                    $copies[] = $copy;
                    $created = $created || $wasCreated;
                }
                $results[] = ['room_id' => $target->id, 'messages' => $copies];
            } catch (Throwable $e) {
                report($e);
                $lastError = $e;
                $failed[] = $target->id;
            }
        }

        if ($results === [] && $lastError !== null) {
            throw $lastError;
        }

        if ($created) {
            $this->audit->log(
                'message.forwarded',
                actor: $actor,
                targetType: 'room',
                targetId: $source->id,
                context: [
                    'message_ids' => $messages->pluck('id')->all(),
                    'room_ids' => array_column($results, 'room_id'),
                    'failed_room_ids' => $failed,
                ],
                workspaceId: $source->workspace_id,
            );
        }

        return ['results' => $results, 'failed_room_ids' => $failed, 'created' => $created];
    }

    /**
     * @param  list<string>  $messageIds
     * @return Collection<int, Message>
     */
    private function sourceMessages(Room $source, array $messageIds)
    {
        $messages = Message::query()
            ->where('room_id', $source->id)
            ->whereKey($messageIds)
            ->with(['attachments', 'sender:id,display_name'])
            ->orderBy('seq')
            ->get();

        if ($messages->count() !== count($messageIds)) {
            throw ApiException::msgForwardInvalid('message_not_found');
        }

        foreach ($messages as $message) {
            if ($message->deleted_at !== null) {
                throw ApiException::msgForwardInvalid('message_deleted');
            }
            if ($message->type === MessageType::System || $message->sender_id === null) {
                throw ApiException::msgForwardInvalid('system_message');
            }
            foreach ($message->attachments as $attachment) {
                if ($attachment->status !== AttachmentStatus::Ready || $attachment->deleted_at !== null) {
                    throw ApiException::msgForwardInvalid('attachment_not_ready');
                }
            }
        }

        return $messages;
    }

    /**
     * Same visibility as the room list (RoomController::index): same workspace,
     * not deleted, not an expired secret room, forwarder is a current member.
     * Any miss is one uniform 404 so a room id never confirms its existence.
     *
     * @param  list<string>  $roomIds
     * @return list<Room>
     */
    private function targets(User $actor, array $roomIds): array
    {
        $rooms = Room::query()
            ->where('workspace_id', $this->context->id())
            ->whereNull('deleted_at')
            ->whereKey($roomIds)
            ->where(fn ($q) => $q->where('is_secret', false)->orWhere('secret_expires_at', '>', now()))
            ->whereHas('members', fn ($q) => $q->where('room_members.user_id', $actor->id)->whereNull('room_members.left_at'))
            ->get()
            ->keyBy('id');

        if ($rooms->count() !== count($roomIds)) {
            abort(404);
        }

        return array_map(fn (string $id) => $rooms->get($id), $roomIds);
    }

    /**
     * @return array{0: Message, 1: bool}
     */
    private function forwardOne(User $actor, string $forwardId, Message $message, Room $target): array
    {
        $clientMessageId = (string) Uuid::uuid5($forwardId, $message->id.':'.$target->id);

        // replay: answer before copying any bytes, or every retry mints orphan files
        $existing = Message::query()
            ->where('room_id', $target->id)
            ->where('sender_id', $actor->id)
            ->where('client_message_id', $clientMessageId)
            ->first();
        if ($existing !== null) {
            return [$existing, false];
        }

        $copies = $this->copyAttachments($message, $actor);

        try {
            [$copy, $created] = $this->writer->write(
                $target,
                $actor,
                $message->body,
                $clientMessageId,
                null,
                array_map(fn (Attachment $a) => $a->id, $copies),
                true,
                ['forward' => $this->origin($message)],
            );
        } catch (Throwable $e) {
            $this->discard($copies);
            throw $e;
        }

        if (! $created) {
            $this->discard($copies); // lost a race with a concurrent replay
        }

        return [$copy, $created];
    }

    /**
     * Chain-collapse: re-forwarding keeps the FIRST author (Telegram behaviour).
     *
     * @return array<string, mixed>
     */
    private function origin(Message $message): array
    {
        $forward = $message->metadata['forward'] ?? null;
        if (is_array($forward)) {
            return $forward;
        }

        return [
            'sender_id' => $message->sender_id,
            'display_name' => $message->sender?->display_name,
            'message_id' => $message->id,
            'room_id' => $message->room_id,
            'created_at' => $message->created_at?->toIso8601String(),
        ];
    }

    /**
     * DEC-083 (a) — copy bytes, never share rows or keys: every purge path deletes
     * by an attachment's own storage_key + derived keys, so sharing would let the
     * source's deletion (or its secret room's expiry) destroy the forwarded file.
     *
     * @return list<Attachment>
     */
    private function copyAttachments(Message $message, User $actor): array
    {
        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        $copies = [];
        $writtenKeys = [];

        try {
            foreach ($message->attachments->sortBy(fn ($a) => $a->pivot->position ?? 0) as $attachment) {
                $id = strtolower((string) Str::ulid());
                $prefix = 'ws/'.$attachment->workspace_id.'/att/'.$id;

                $storageKey = $prefix.'/original';
                $disk->copy($attachment->storage_key, $storageKey);
                $writtenKeys[] = $storageKey;

                $derived = [];
                foreach ($attachment->derived ?? [] as $name => $key) {
                    if (! is_string($key) || $key === '') {
                        continue;
                    }
                    $newKey = $prefix.'/'.$name;
                    $disk->copy($key, $newKey);
                    $writtenKeys[] = $newKey;
                    $derived[$name] = $newKey;
                }

                $copy = new Attachment;
                $copy->forceFill([
                    'id' => $id,
                    'workspace_id' => $attachment->workspace_id,
                    'uploader_id' => $actor->id,
                    'public_chat_room_id' => null,
                    'kind' => $attachment->kind,
                    'status' => AttachmentStatus::Ready,
                    'original_name' => $attachment->original_name,
                    'mime_type' => $attachment->mime_type,
                    'size_bytes' => $attachment->size_bytes,
                    'storage_key' => $storageKey,
                    'scan_result' => $attachment->scan_result,
                    'width' => $attachment->width,
                    'height' => $attachment->height,
                    'duration_ms' => $attachment->duration_ms,
                    'derived' => $derived === [] ? null : $derived,
                    'expires_at' => null,
                ])->save();
                $copies[] = $copy;
            }
        } catch (Throwable $e) {
            foreach ($writtenKeys as $key) {
                $disk->delete($key);
            }
            $this->discard($copies);
            throw $e;
        }

        return $copies;
    }

    /**
     * Unsent copies are never swept (DEC-073 covers public-chat orphans only),
     * so remove both the objects and the rows here.
     *
     * @param  list<Attachment>  $copies
     */
    private function discard(array $copies): void
    {
        if ($copies === []) {
            return;
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        foreach ($copies as $copy) {
            foreach (array_filter(array_merge([$copy->storage_key], array_values($copy->derived ?? []))) as $key) {
                $disk->delete($key);
            }
            Attachment::withoutGlobalScopes()->whereKey($copy->id)->delete();
        }
    }
}
