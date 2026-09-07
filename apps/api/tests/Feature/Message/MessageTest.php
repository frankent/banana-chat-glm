<?php

use App\Enums\RoomRole;
use App\Events\MessageCreated;
use App\Events\RoomActivity;
use App\Events\RoomRead;
use App\Events\WorkspaceUnreadChanged;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;

/**
 * TC-MSG-001..011, TC-READ-001..005 — send, idempotency, pagination,
 * read receipts (FR-MSG-001/003/009, FR-READ-001/002, TASK-BE-007..009).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);

    $this->room = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 2,
        'last_message_at' => now(),
    ]);

    foreach ([$this->tony, $this->somchai] as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $i === 0 ? RoomRole::Owner : RoomRole::Member,
            'added_by' => $this->tony->id,
        ]);
    }
});

function sendMsg($test, string $token, string $roomId, string $body, ?string $clientMessageId = null, array $extra = [])
{
    return $test->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => $clientMessageId ?? (string) Str::uuid(),
        'body' => $body,
    ] + $extra, wsHeaders($token, 'acme'));
}

test('TC-MSG-001 send text → 201, seq assigned, room counters bumped, sender read pointer advances', function () {
    [$user, $token] = loginAs($this->tony);

    $response = sendMsg($this, $token, $this->room->id, 'สวัสดีทุกคน');

    $response->assertStatus(201)
        ->assertJsonPath('data.message.body', 'สวัสดีทุกคน')
        ->assertJsonPath('data.message.seq', 1)
        ->assertJsonPath('data.message.type', 'text');

    $room = $this->room->fresh();
    expect($room->last_seq)->toBe(1)
        ->and($room->last_user_seq)->toBe(1)
        ->and($room->last_message_id)->toBe($response->json('data.message.id'))
        ->and($room->last_message_at)->not->toBeNull()
        ->and(RoomMember::query()->where('room_id', $room->id)->where('user_id', $this->tony->id)->first()->last_read_seq)->toBe(1);
});

test('TC-MSG-002 duplicate client_message_id → 200 with the original message (idempotent)', function () {
    [$user, $token] = loginAs($this->tony);
    $cmid = (string) Str::uuid();

    $first = sendMsg($this, $token, $this->room->id, 'hello', $cmid);
    $second = sendMsg($this, $token, $this->room->id, 'hello', $cmid);

    $first->assertStatus(201);
    $second->assertStatus(200)
        ->assertJsonPath('data.message.id', $first->json('data.message.id'));

    expect(Message::query()->where('room_id', $this->room->id)->count())->toBe(1);
});

test('TC-MSG-003 body over max_length → 422 MSG_TOO_LONG', function () {
    [$user, $token] = loginAs($this->tony);

    sendMsg($this, $token, $this->room->id, str_repeat('x', 4001))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_TOO_LONG');
});

test('TC-MSG-004 whitespace-only body → 422 MSG_EMPTY', function () {
    [$user, $token] = loginAs($this->tony);

    sendMsg($this, $token, $this->room->id, "  \n\t ")
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_EMPTY');
});

test('TC-MSG-005 sending from a deleted room → 404', function () {
    [$user, $token] = loginAs($this->tony);
    $this->room->forceFill(['deleted_at' => now()])->save();

    sendMsg($this, $token, $this->room->id, 'hello')
        ->assertStatus(404);
});

test('TC-MSG-009 left member sends → 403 ROOM_NOT_MEMBER', function () {
    RoomMember::query()->where('room_id', $this->room->id)->where('user_id', $this->somchai->id)
        ->update(['left_at' => now()]);

    [$user, $token] = loginAs($this->somchai);

    sendMsg($this, $token, $this->room->id, 'let me in')
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');
});

test('burst of 20 sends → contiguous unique seqs (D6 lock discipline)', function () {
    [$user, $token] = loginAs($this->tony);

    for ($i = 0; $i < 20; $i++) {
        sendMsg($this, $token, $this->room->id, "msg {$i}")->assertStatus(201);
    }

    $seqs = Message::query()->where('room_id', $this->room->id)->orderBy('seq')->pluck('seq')->all();

    expect($seqs)->toBe(range(1, 20))
        ->and($this->room->fresh()->last_seq)->toBe(20)
        ->and(count($seqs))->toBe(count(array_unique($seqs)));
});

test('schema guards: unique (room_id, seq) and (room_id, sender_id, client_message_id) indexes exist', function () {
    // DB-level backstop for D6 — the row lock prevents duplicates in practice,
    // these constraints make seq gaps/dupes impossible even under failure.
    $names = DB::table('pg_indexes')
        ->where('tablename', 'messages')
        ->where('indexdef', 'like', 'CREATE UNIQUE%')
        ->pluck('indexname');

    expect($names)->toContain('messages_room_id_seq_unique')
        ->and($names)->toContain('messages_room_id_sender_id_client_message_id_unique');
});

test('TC-MSG-019 history: default latest 50 ascending + has_more flags (FR-MSG-003)', function () {
    [$user, $token] = loginAs($this->tony);

    for ($i = 1; $i <= 60; $i++) {
        Message::query()->create([
            'room_id' => $this->room->id,
            'workspace_id' => $this->ws->id,
            'sender_id' => $this->tony->id,
            'seq' => $i,
            'type' => 'text',
            'body' => "seed {$i}",
            'client_message_id' => (string) Str::uuid(),
        ]);
    }
    $this->room->fresh()->forceFill(['last_seq' => 60, 'last_user_seq' => 60])->save();

    $response = $this->getJson("/api/v1/rooms/{$this->room->id}/messages", wsHeaders($token, 'acme'));

    $response->assertOk();
    $messages = collect($response->json('data.messages'));

    expect($messages)->toHaveCount(50)
        ->and($messages->first()['seq'])->toBe(11)
        ->and($messages->last()['seq'])->toBe(60)
        ->and($response->json('data.has_more_before'))->toBeTrue()
        ->and($response->json('data.has_more_after'))->toBeFalse()
        ->and($messages->first()['sender']['username'])->toBe('tony');
});

test('TC-MSG-020 before_seq pages older history; after_seq fills gaps ascending', function () {
    [$user, $token] = loginAs($this->tony);

    foreach ([1, 2, 3, 4, 5] as $seq) {
        Message::query()->create([
            'room_id' => $this->room->id,
            'workspace_id' => $this->ws->id,
            'sender_id' => $this->tony->id,
            'seq' => $seq,
            'type' => 'text',
            'body' => "seed {$seq}",
            'client_message_id' => (string) Str::uuid(),
        ]);
    }

    $older = $this->getJson("/api/v1/rooms/{$this->room->id}/messages?before_seq=4&limit=2", wsHeaders($token, 'acme'));
    expect(collect($older->json('data.messages'))->pluck('seq')->all())->toBe([2, 3])
        ->and($older->json('data.has_more_before'))->toBeTrue();

    $oldest = $this->getJson("/api/v1/rooms/{$this->room->id}/messages?before_seq=2&limit=2", wsHeaders($token, 'acme'));
    expect(collect($oldest->json('data.messages'))->pluck('seq')->all())->toBe([1])
        ->and($oldest->json('data.has_more_before'))->toBeFalse();

    $newer = $this->getJson("/api/v1/rooms/{$this->room->id}/messages?after_seq=1&limit=2", wsHeaders($token, 'acme'));
    expect(collect($newer->json('data.messages'))->pluck('seq')->all())->toBe([2, 3])
        ->and($newer->json('data.has_more_after'))->toBeTrue();
});

test('TC-MSG-045 deleted messages keep seq as placeholders (body null)', function () {
    [$user, $token] = loginAs($this->tony);

    $message = Message::query()->create([
        'room_id' => $this->room->id,
        'workspace_id' => $this->ws->id,
        'sender_id' => $this->tony->id,
        'seq' => 1,
        'type' => 'text',
        'body' => 'to be deleted',
        'client_message_id' => (string) Str::uuid(),
    ]);
    $message->forceFill(['deleted_at' => now(), 'body' => null, 'delete_reason' => 'sender'])->save();

    $response = $this->getJson("/api/v1/rooms/{$this->room->id}/messages", wsHeaders($token, 'acme'));

    $entry = collect($response->json('data.messages'))->first();
    expect($entry['seq'])->toBe(1)
        ->and($entry['body'])->toBeNull()
        ->and($entry['deleted_at'])->not->toBeNull();
});

test('reply_to returns a snippet stub of the original', function () {
    [$user, $token] = loginAs($this->tony);

    $original = sendMsg($this, $token, $this->room->id, 'original message')->json('data.message.id');

    $reply = sendMsg($this, $token, $this->room->id, 'a reply', null, [
        'reply_to_message_id' => $original,
    ]);

    $reply->assertStatus(201)
        ->assertJsonPath('data.message.reply_to.id', $original)
        ->assertJsonPath('data.message.reply_to.snippet', 'original message');
});

test('reply_to from another room → 422 MSG_REPLY_INVALID', function () {
    [$user, $token] = loginAs($this->tony);

    $otherRoom = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Elsewhere',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 1,
        'last_message_at' => now(),
    ]);
    RoomMember::query()->create([
        'room_id' => $otherRoom->id,
        'user_id' => $this->tony->id,
        'workspace_id' => $this->ws->id,
        'role' => RoomRole::Owner,
        'added_by' => $this->tony->id,
    ]);
    $foreign = Message::query()->create([
        'room_id' => $otherRoom->id,
        'workspace_id' => $this->ws->id,
        'sender_id' => $this->tony->id,
        'seq' => 1,
        'type' => 'text',
        'body' => 'foreign',
        'client_message_id' => (string) Str::uuid(),
    ]);

    sendMsg($this, $token, $this->room->id, 'reply', null, ['reply_to_message_id' => $foreign->id])
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_REPLY_INVALID');
});

test('sending broadcasts message.created + room.activity + workspace.unread_changed', function () {
    Event::fake([MessageCreated::class, RoomActivity::class, WorkspaceUnreadChanged::class]);

    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'hello events')->assertStatus(201);

    Event::assertDispatched(MessageCreated::class, fn (MessageCreated $e) => $e->message['body'] === 'hello events');
    // room.activity to somchai (reader sees unread), workspace.unread_changed to somchai
    Event::assertDispatchedTimes(RoomActivity::class, 2); // both members
    Event::assertDispatched(WorkspaceUnreadChanged::class, fn ($e) => $e->userId === $this->somchai->id);
});

test('TC-READ-001 mark read advances pointer and broadcasts room.read', function () {
    Event::fake([RoomRead::class]);

    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'one');
    sendMsg($this, $token, $this->room->id, 'two');

    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 2], wsHeaders($somchaiToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.last_read_seq', 2);

    expect(RoomMember::query()->where('room_id', $this->room->id)->where('user_id', $this->somchai->id)->first()->last_read_seq)->toBe(2);
    Event::assertDispatched(RoomRead::class, fn (RoomRead $e) => $e->lastReadSeq === 2 && $e->userId === $this->somchai->id);
});

test('TC-READ-002 seq going backwards is ignored (monotonic)', function () {
    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'one');
    sendMsg($this, $token, $this->room->id, 'two');

    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 2], wsHeaders($somchaiToken, 'acme'))->assertOk();
    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 1], wsHeaders($somchaiToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.last_read_seq', 2);

    expect(RoomMember::query()->where('room_id', $this->room->id)->where('user_id', $this->somchai->id)->first()->last_read_seq)->toBe(2);
});

test('TC-READ-003 seq above last_seq clamps to last_seq', function () {
    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'only');

    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 999], wsHeaders($somchaiToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.last_read_seq', 1);
});

test('TC-READ-004 read-status lists members who reached a seq', function () {
    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'hello');
    sendMsg($this, $token, $this->room->id, 'world');

    [$somchai, $somchaiToken] = loginAs($this->somchai);
    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 1], wsHeaders($somchaiToken, 'acme'))->assertOk();

    $response = $this->getJson("/api/v1/rooms/{$this->room->id}/read-status?seq=1", wsHeaders($token, 'acme'));

    $readBy = collect($response->json('data.read_by'))->keyBy('user_id');
    expect($readBy->has($this->somchai->id))->toBeTrue()   // read seq 1
        ->and($readBy->has($this->tony->id))->toBeTrue();  // read seq 2 (own messages)
});

test('unread badge math: room list unread reflects last_seq − last_read_seq after sends', function () {
    [$user, $token] = loginAs($this->tony);
    sendMsg($this, $token, $this->room->id, 'one');
    sendMsg($this, $token, $this->room->id, 'two');

    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $list = $this->getJson('/api/v1/rooms', wsHeaders($somchaiToken, 'acme'));
    $entry = collect($list->json('data'))->first(fn ($r) => $r['room']['id'] === $this->room->id);

    expect($entry['unread_count'])->toBe(2);

    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => 2], wsHeaders($somchaiToken, 'acme'))->assertOk();

    $list = $this->getJson('/api/v1/rooms', wsHeaders($somchaiToken, 'acme'));
    $entry = collect($list->json('data'))->first(fn ($r) => $r['room']['id'] === $this->room->id);

    expect($entry['unread_count'])->toBe(0);
});

test('TC-MSG-021 around_seq returns 25 before + 25 after, ascending (API-041)', function () {
    [$user, $token] = loginAs($this->tony);

    for ($i = 1; $i <= 70; $i++) {
        Message::query()->create([
            'room_id' => $this->room->id,
            'workspace_id' => $this->ws->id,
            'sender_id' => $this->tony->id,
            'seq' => $i,
            'type' => 'text',
            'body' => "seed {$i}",
            'client_message_id' => (string) Str::uuid(),
        ]);
    }
    $this->room->fresh()->forceFill(['last_seq' => 70, 'last_user_seq' => 70])->save();

    $response = $this->getJson(
        "/api/v1/rooms/{$this->room->id}/messages?around_seq=40",
        wsHeaders($token, 'acme'),
    )->assertOk();

    $messages = collect($response->json('data.messages'));

    expect($messages)->toHaveCount(50)
        ->and($messages->first()['seq'])->toBe(16)   # anchor-25 (inclusive)
        ->and($messages->last()['seq'])->toBe(65)    # anchor+25
        ->and($messages->firstWhere('seq', 40))->not->toBeNull()
        ->and($response->json('data.has_more_before'))->toBeTrue()
        ->and($response->json('data.has_more_after'))->toBeTrue();
});
