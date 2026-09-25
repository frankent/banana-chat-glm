<?php

use App\Enums\MessageType;
use App\Enums\RoomRole;
use App\Events\MessageCreated;
use App\Jobs\GenerateRoomBotReply;
use App\Jobs\PurgeAttachmentFiles;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * TC-MSG-061..071 — forward messages to other rooms (FR-MSG-011, API-047, DEC-083).
 */
beforeEach(function () {
    Storage::fake(config('filesystems.default'));

    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai Jaidee']);
    $this->anna = User::factory()->create(['username' => 'anna']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    foreach ([$this->tony, $this->somchai, $this->anna] as $i => $user) {
        $this->ws->members()->attach($user->id, ['role' => $i === 0 ? 'owner' : 'member']);
    }

    $this->source = fwdRoom($this->ws, 'Engineering', [$this->tony, $this->somchai]);
    $this->targetA = fwdRoom($this->ws, 'Design', [$this->tony, $this->somchai, $this->anna]);
    $this->targetB = fwdRoom($this->ws, 'Ops', [$this->tony, $this->anna]);
});

// settings live in the cache store, which RefreshDatabase does not roll back
afterEach(fn () => app(SettingsService::class)->flush());

function fwdRoom(Workspace $ws, string $name, array $members, array $extra = []): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => $name,
        'created_by' => $members[0]->id,
        'owner_id' => $members[0]->id,
        'member_count' => count($members),
        'last_message_at' => now(),
    ] + $extra);

    foreach ($members as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $room->id,
            'user_id' => $user->id,
            'workspace_id' => $ws->id,
            'role' => $i === 0 ? RoomRole::Owner : RoomRole::Member,
            'added_by' => $members[0]->id,
        ]);
    }

    return $room;
}

function fwdSend($test, string $token, string $roomId, ?string $body, array $attachmentIds = []): array
{
    $response = $test->postJson("/api/v1/rooms/{$roomId}/messages", array_filter([
        'client_message_id' => (string) Str::uuid(),
        'body' => $body,
        'attachment_ids' => $attachmentIds ?: null,
    ]), wsHeaders($token, 'acme'))->assertStatus(201);

    return $response->json('data.message');
}

function fwd($test, string $token, string $sourceRoomId, array $messageIds, array $roomIds, ?string $forwardId = null)
{
    return $test->postJson('/api/v1/messages/forward', [
        'client_forward_id' => $forwardId ?? (string) Str::uuid(),
        'source_room_id' => $sourceRoomId,
        'message_ids' => $messageIds,
        'room_ids' => $roomIds,
    ], wsHeaders($token, 'acme'));
}

function fwdImage(Workspace $ws, User $uploader, string $status = 'ready'): Attachment
{
    $id = strtolower((string) Str::ulid());
    $disk = Storage::disk(config('filesystems.default'));
    $original = "ws/{$ws->id}/att/{$id}/original";
    $thumb = "ws/{$ws->id}/att/{$id}/thumb_sm";
    $disk->put($original, 'png-bytes');
    $disk->put($thumb, 'webp-bytes');

    $attachment = new Attachment;
    $attachment->forceFill([
        'id' => $id,
        'workspace_id' => $ws->id,
        'uploader_id' => $uploader->id,
        'kind' => 'image',
        'status' => $status,
        'original_name' => 'photo.png',
        'mime_type' => 'image/png',
        'size_bytes' => 9,
        'storage_key' => $original,
        'width' => 10,
        'height' => 10,
        'derived' => ['thumb_sm' => $thumb],
    ])->save();

    return $attachment;
}

test('TC-MSG-061 forward → one copy per target, sent by forwarder, carrying the original author, also on EVT-010', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    [, $tonyToken] = loginAs($this->tony);
    $original = fwdSend($this, $somchaiToken, $this->source->id, 'ประชุม 10 โมง');

    Event::fake([MessageCreated::class]);

    $response = fwd($this, $tonyToken, $this->source->id, [$original['id']], [$this->targetA->id, $this->targetB->id])
        ->assertStatus(201)
        ->assertJsonPath('data.failed_room_ids', [])
        ->assertJsonCount(2, 'data.results');

    foreach ([$this->targetA, $this->targetB] as $i => $target) {
        $response->assertJsonPath("data.results.{$i}.room_id", $target->id)
            ->assertJsonPath("data.results.{$i}.messages.0.body", 'ประชุม 10 โมง')
            ->assertJsonPath("data.results.{$i}.messages.0.sender_id", $this->tony->id)
            ->assertJsonPath("data.results.{$i}.messages.0.forwarded_from.sender_id", $this->somchai->id)
            ->assertJsonPath("data.results.{$i}.messages.0.forwarded_from.display_name", 'Somchai Jaidee')
            ->assertJsonPath("data.results.{$i}.messages.0.forwarded_from.message_id", $original['id'])
            ->assertJsonPath("data.results.{$i}.messages.0.forwarded_from.room_id", $this->source->id);

        expect($target->fresh()->last_seq)->toBe(1);
    }

    Event::assertDispatched(MessageCreated::class, fn (MessageCreated $e) => $e->room->id === $this->targetA->id
        && ($e->message['forwarded_from']['sender_id'] ?? null) === $this->somchai->id);

    $this->assertDatabaseHas('audit_logs', ['action' => 'message.forwarded', 'actor_id' => $this->tony->id]);
});

test('TC-MSG-062 re-forwarding a forward keeps the first author', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    [, $tonyToken] = loginAs($this->tony);
    $original = fwdSend($this, $somchaiToken, $this->source->id, 'hello');

    $copyId = fwd($this, $tonyToken, $this->source->id, [$original['id']], [$this->targetA->id])
        ->assertStatus(201)->json('data.results.0.messages.0.id');

    [, $annaToken] = loginAs($this->anna);
    fwd($this, $annaToken, $this->targetA->id, [$copyId], [$this->targetB->id])
        ->assertStatus(201)
        ->assertJsonPath('data.results.0.messages.0.sender_id', $this->anna->id)
        ->assertJsonPath('data.results.0.messages.0.forwarded_from.sender_id', $this->somchai->id)
        ->assertJsonPath('data.results.0.messages.0.forwarded_from.message_id', $original['id']);
});

test('TC-MSG-063 forwarded attachment gets new storage objects that survive deleting the source', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    [, $tonyToken] = loginAs($this->tony);
    $image = fwdImage($this->ws, $this->somchai);
    $original = fwdSend($this, $somchaiToken, $this->source->id, null, [$image->id]);

    $copy = fwd($this, $tonyToken, $this->source->id, [$original['id']], [$this->targetA->id])
        ->assertStatus(201)
        ->assertJsonPath('data.results.0.messages.0.type', 'image')
        ->json('data.results.0.messages.0');

    $copyAttachment = Attachment::withoutGlobalScopes()->findOrFail($copy['attachments'][0]['id']);
    expect($copyAttachment->id)->not->toBe($image->id)
        ->and($copyAttachment->uploader_id)->toBe($this->tony->id)
        ->and($copyAttachment->storage_key)->not->toBe($image->storage_key)
        ->and($copyAttachment->derived['thumb_sm'])->not->toBe($image->derived['thumb_sm']);

    // sender deletes the source, then the 24h purge (FR-MEDIA-006) runs — it is
    // dispatched afterCommit, which never happens inside RefreshDatabase
    $this->deleteJson("/api/v1/messages/{$original['id']}", [], wsHeaders($somchaiToken, 'acme'))->assertSuccessful();
    (new PurgeAttachmentFiles([$image->id]))->handle();

    $disk = Storage::disk(config('filesystems.default'));
    expect($disk->exists($image->storage_key))->toBeFalse()
        ->and($disk->exists($copyAttachment->storage_key))->toBeTrue()
        ->and($disk->get($copyAttachment->storage_key))->toBe('png-bytes')
        ->and($disk->exists($copyAttachment->derived['thumb_sm']))->toBeTrue();
});

test('TC-MSG-064 secret source is refused, secret target is allowed', function () {
    [, $tonyToken] = loginAs($this->tony);
    $secret = fwdRoom($this->ws, 'Hush', [$this->tony, $this->somchai], ['is_secret' => true, 'secret_expires_at' => now()->addDays(3)]);
    $inSecret = fwdSend($this, $tonyToken, $secret->id, 'secret words');

    fwd($this, $tonyToken, $secret->id, [$inSecret['id']], [$this->targetA->id])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_FORWARD_INVALID');
    expect(Message::query()->where('room_id', $this->targetA->id)->count())->toBe(0);

    $plain = fwdSend($this, $tonyToken, $this->source->id, 'fine to share');
    fwd($this, $tonyToken, $this->source->id, [$plain['id']], [$secret->id])->assertStatus(201);
});

test('TC-MSG-065 non-member source → 403; foreign or non-member target → 404 and nothing is written', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    $original = fwdSend($this, $somchaiToken, $this->source->id, 'x');

    [, $annaToken] = loginAs($this->anna);
    fwd($this, $annaToken, $this->source->id, [$original['id']], [$this->targetA->id])
        ->assertStatus(403)->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');

    // somchai is in A but not in B: the whole request fails before A gets anything
    fwd($this, $somchaiToken, $this->source->id, [$original['id']], [$this->targetA->id, $this->targetB->id])
        ->assertStatus(404);

    $otherWs = Workspace::factory()->create(['slug' => 'other']);
    $otherWs->members()->attach($this->somchai->id, ['role' => 'member']);
    $foreign = fwdRoom($otherWs, 'Elsewhere', [$this->somchai]);
    fwd($this, $somchaiToken, $this->source->id, [$original['id']], [$foreign->id])->assertStatus(404);

    $this->targetA->forceFill(['deleted_at' => now()])->save();
    fwd($this, $somchaiToken, $this->source->id, [$original['id']], [$this->targetA->id])->assertStatus(404);

    expect(Message::query()->whereIn('room_id', [$this->targetA->id, $this->targetB->id, $foreign->id])->count())->toBe(0);
});

test('TC-MSG-066 deleted, system, foreign-room or not-ready sources → 422', function () {
    [, $tonyToken] = loginAs($this->tony);

    $deleted = fwdSend($this, $tonyToken, $this->source->id, 'gone');
    $this->deleteJson("/api/v1/messages/{$deleted['id']}", [], wsHeaders($tonyToken, 'acme'))->assertSuccessful();
    fwd($this, $tonyToken, $this->source->id, [$deleted['id']], [$this->targetA->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'message_deleted');

    $system = Message::query()->create([
        'room_id' => $this->source->id, 'workspace_id' => $this->ws->id, 'sender_id' => null,
        'seq' => 99, 'type' => MessageType::System, 'system_event' => ['kind' => 'room_created'],
    ]);
    fwd($this, $tonyToken, $this->source->id, [$system->id], [$this->targetA->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'system_message');

    $elsewhere = fwdSend($this, $tonyToken, $this->targetB->id, 'not in source');
    fwd($this, $tonyToken, $this->source->id, [$elsewhere['id']], [$this->targetA->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'message_not_found');

    $processing = fwdImage($this->ws, $this->tony, 'processing');
    $pending = fwdSend($this, $tonyToken, $this->source->id, null, [$processing->id]);
    fwd($this, $tonyToken, $this->source->id, [$pending['id']], [$this->targetA->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'attachment_not_ready');
});

test('TC-MSG-067 message and room count limits', function () {
    [, $tonyToken] = loginAs($this->tony);
    $a = fwdSend($this, $tonyToken, $this->source->id, 'a');
    $b = fwdSend($this, $tonyToken, $this->source->id, 'b');

    app(SettingsService::class)->set('message.forward_max_rooms', 1);
    fwd($this, $tonyToken, $this->source->id, [$a['id']], [$this->targetA->id, $this->targetB->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'too_many_rooms');

    app(SettingsService::class)->set('message.forward_max_messages', 1);
    fwd($this, $tonyToken, $this->source->id, [$a['id'], $b['id']], [$this->targetA->id])
        ->assertStatus(422)->assertJsonPath('error.details.reason', 'too_many_messages');
});

test('TC-MSG-068 replaying the same client_forward_id creates nothing new', function () {
    [, $tonyToken] = loginAs($this->tony);
    $image = fwdImage($this->ws, $this->tony);
    $a = fwdSend($this, $tonyToken, $this->source->id, 'first');
    $b = fwdSend($this, $tonyToken, $this->source->id, null, [$image->id]);
    $forwardId = (string) Str::uuid();

    $first = fwd($this, $tonyToken, $this->source->id, [$b['id'], $a['id']], [$this->targetA->id], $forwardId)
        ->assertStatus(201);
    // source seq order, not request order
    expect($first->json('data.results.0.messages.0.body'))->toBe('first');

    $attachmentsBefore = Attachment::withoutGlobalScopes()->count();
    fwd($this, $tonyToken, $this->source->id, [$a['id'], $b['id']], [$this->targetA->id], $forwardId)
        ->assertStatus(200)
        ->assertJsonPath('data.results.0.messages.0.id', $first->json('data.results.0.messages.0.id'));

    expect(Message::query()->where('room_id', $this->targetA->id)->count())->toBe(2)
        ->and(Attachment::withoutGlobalScopes()->count())->toBe($attachmentsBefore);
});

test('TC-MSG-069 a forwarded message cannot be edited, but can be deleted', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    [, $tonyToken] = loginAs($this->tony);
    $original = fwdSend($this, $somchaiToken, $this->source->id, 'I approve');
    $copyId = fwd($this, $tonyToken, $this->source->id, [$original['id']], [$this->targetA->id])
        ->json('data.results.0.messages.0.id');

    $this->patchJson("/api/v1/messages/{$copyId}", ['body' => 'I approve the budget cut'], wsHeaders($tonyToken, 'acme'))
        ->assertStatus(422)->assertJsonPath('error.code', 'MSG_NOT_EDITABLE');

    $this->deleteJson("/api/v1/messages/{$copyId}", [], wsHeaders($tonyToken, 'acme'))->assertSuccessful();
});

test('TC-MSG-070 a forwarded @user / @ai body creates no mentions and no AI bot job', function () {
    [, $somchaiToken] = loginAs($this->somchai);
    [, $tonyToken] = loginAs($this->tony);
    $original = fwdSend($this, $somchaiToken, $this->source->id, '@anna @ai please summarise');

    Queue::fake();
    $copyId = fwd($this, $tonyToken, $this->source->id, [$original['id']], [$this->targetA->id])
        ->assertStatus(201)
        ->assertJsonPath('data.results.0.messages.0.mentions', [])
        ->json('data.results.0.messages.0.id');

    expect(DB::table('message_mentions')->where('message_id', $copyId)->count())->toBe(0);
    Queue::assertNotPushed(GenerateRoomBotReply::class);
});

test('TC-MSG-071 raw metadata is never serialized, only forwarded_from', function () {
    [, $tonyToken] = loginAs($this->tony);
    $plain = fwdSend($this, $tonyToken, $this->source->id, 'plain');
    expect($plain)->toHaveKey('forwarded_from')
        ->and($plain['forwarded_from'])->toBeNull()
        ->and($plain)->not->toHaveKey('metadata');

    $copy = fwd($this, $tonyToken, $this->source->id, [$plain['id']], [$this->targetA->id])
        ->json('data.results.0.messages.0');
    expect($copy)->not->toHaveKey('metadata')
        ->and(array_keys($copy['forwarded_from']))->toBe(['sender_id', 'display_name', 'message_id', 'room_id', 'created_at']);

    $history = $this->getJson("/api/v1/rooms/{$this->targetA->id}/messages", wsHeaders($tonyToken, 'acme'))
        ->assertOk()->json('data.messages.0');
    expect($history['forwarded_from']['message_id'])->toBe($plain['id'])
        ->and($history)->not->toHaveKey('metadata');
});
