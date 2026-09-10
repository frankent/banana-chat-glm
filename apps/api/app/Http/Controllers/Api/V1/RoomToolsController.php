<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\AttachmentSerializer;
use App\Domain\Message\MessageSerializer;
use App\Domain\Room\RoomPolicy;
use App\Events\RoomToolEvent;
use App\Jobs\PurgeAttachmentFiles;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomNote;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/** FR-NOTE-001 / FR-PIN-001 / FR-RT-003 — API-130..137. */
class RoomToolsController
{
    private function room(Request $r, string $id): Room
    {
        $room = Room::whereNull('deleted_at')->findOrFail($id);
        app(RoomPolicy::class)->membershipOrFail($room, $r->user());

        return $room;
    }

    private function noteArray(RoomNote $n): array
    {
        return ['id' => $n->id, 'room_id' => $n->room_id, 'author_id' => $n->author_id,
            'author_name' => $n->author->display_name, 'body' => $n->body,
            'created_at' => $n->created_at->toIso8601String(), 'updated_at' => $n->updated_at->toIso8601String(),
            'attachments' => $n->attachments->map(fn ($a) => app(AttachmentSerializer::class)->toArray($a))->all()];
    }

    public function notes(Request $r, string $roomId)
    {
        $room = $this->room($r, $roomId);
        $r->validate(['before' => 'nullable|ulid']);
        $rows = RoomNote::where('room_id', $room->id)->when($r->query('before'), fn ($q, $id) => $q->where('id', '<', $id))->with(['author', 'attachments'])->orderByDesc('id')->limit(31)->get();

        return response()->json(['data' => ['notes' => $rows->take(30)->map(fn ($n) => $this->noteArray($n))->values(), 'has_more' => $rows->count() > 30]]);
    }

    public function createNote(Request $r, string $roomId)
    {
        $room = $this->room($r, $roomId);
        $data = $r->validate(['body' => 'nullable|string|max:20000', 'attachment_ids' => 'array|max:10', 'attachment_ids.*' => 'required|ulid|distinct']);
        abort_if(trim($data['body'] ?? '') === '' && empty($data['attachment_ids']), 422, 'A note needs text or attachments.');
        $note = DB::transaction(function () use ($r, $room, $data) {
            $ids = $data['attachment_ids'] ?? [];
            $attachments = Attachment::whereIn('id', $ids)->lockForUpdate()->get();
            abort_unless($attachments->count() === count($ids), 422);
            foreach ($attachments as $a) {
                abort_unless($a->uploader_id === $r->user()->id && $a->workspace_id === $room->workspace_id && $a->deleted_at === null && in_array($a->kind->value, ['image', 'video', 'file']) && in_array($a->status->value, ['ready', 'processing', 'uploaded']) && ! $a->messages()->exists() && ! DB::table('room_note_attachments')->where('attachment_id', $a->id)->exists(), 422);
            }
            $note = RoomNote::create(['workspace_id' => $room->workspace_id, 'room_id' => $room->id, 'author_id' => $r->user()->id, 'body' => $data['body'] ?? null]);
            $note->attachments()->attach($ids);

            return $note;
        });
        broadcast(new RoomToolEvent($room, 'room.notes_changed'));

        return response()->json(['data' => $this->noteArray($note)], 201);
    }

    public function updateNote(Request $r, string $roomId, string $noteId)
    {
        $room = $this->room($r, $roomId);
        $note = RoomNote::where('room_id', $room->id)->findOrFail($noteId);
        $policy = app(RoomPolicy::class);
        abort_unless($note->author_id === $r->user()->id || $policy->isRoomAdmin($policy->membership($room, $r->user()), $r->user()), 403);
        $data = $r->validate(['body' => 'nullable|string|max:20000']);
        abort_if(trim($data['body'] ?? '') === '' && ! $note->attachments()->exists(), 422);
        $note->update(['body' => $data['body'] ?? null]);
        broadcast(new RoomToolEvent($room, 'room.notes_changed'));

        return response()->json(['data' => $this->noteArray($note)]);
    }

    public function deleteNote(Request $r, string $roomId, string $noteId)
    {
        $room = $this->room($r, $roomId);
        $note = RoomNote::where('room_id', $room->id)->findOrFail($noteId);
        $policy = app(RoomPolicy::class);
        abort_unless($note->author_id === $r->user()->id || $policy->isRoomAdmin($policy->membership($room, $r->user()), $r->user()), 403);
        $attachmentIds = $note->attachments()->pluck('attachments.id')->all();
        DB::transaction(function () use ($note, $attachmentIds) {
            Attachment::whereIn('id', $attachmentIds)->update(['deleted_at' => now()]);
            $note->delete();
        });
        if ($attachmentIds) {
            PurgeAttachmentFiles::dispatch($attachmentIds)->afterCommit();
        }
        broadcast(new RoomToolEvent($room, 'room.notes_changed'));

        return response()->noContent();
    }

    public function pins(Request $r, string $roomId)
    {
        $room = $this->room($r, $roomId);
        $ids = DB::table('room_pins')->where('room_id', $room->id)->pluck('message_id');
        $messages = Message::where('room_id', $room->id)->whereIn('id', $ids)->whereNull('deleted_at')->orderByDesc('seq')->get();

        return response()->json(['data' => $messages->map(fn ($m) => MessageSerializer::forEvent($m))]);
    }

    public function pin(Request $r, string $roomId, string $messageId)
    {
        $room = $this->room($r, $roomId);
        Message::where('room_id', $room->id)->whereNull('deleted_at')->findOrFail($messageId);
        DB::table('room_pins')->insertOrIgnore(['room_id' => $room->id, 'message_id' => $messageId, 'pinned_by' => $r->user()->id, 'created_at' => now()]);
        broadcast(new RoomToolEvent($room, 'room.pins_changed'));

        return response()->json(['data' => ['pinned' => true]]);
    }

    public function unpin(Request $r, string $roomId, string $messageId)
    {
        $room = $this->room($r, $roomId);
        DB::table('room_pins')->where('room_id', $room->id)->where('message_id', $messageId)->delete();
        broadcast(new RoomToolEvent($room, 'room.pins_changed'));

        return response()->noContent();
    }

    public function typing(Request $r, string $roomId)
    {
        $room = $this->room($r, $roomId);
        $data = $r->validate(['typing' => 'required|boolean']);
        $key = 'typing:'.$room->id.':'.$r->user()->id;
        if (! $data['typing'] || Cache::add($key, true, 2)) {
            broadcast(new RoomToolEvent($room, 'room.typing', ['user_id' => $r->user()->id, 'display_name' => $r->user()->display_name, 'typing' => $data['typing']]));
        }
        if (! $data['typing']) {
            Cache::forget($key);
        }

        return response()->noContent();
    }
}
