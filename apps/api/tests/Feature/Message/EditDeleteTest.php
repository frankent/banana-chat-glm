<?php

use App\Enums\RoomRole;
use App\Events\MessageDeleted;
use App\Events\MessageUpdated;
use App\Events\RoomActivity;
use App\Events\WorkspaceUnreadChanged;
use App\Models\AuditLog;
use App\Models\Message;
use App\Models\MessageEdit;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;

/**
 * TC-MSG-029..044 subset — edit + soft delete (FR-MSG-005/006,
 * API-042/043, EVT-011/012).
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

    [$user, $this->token] = loginAs($this->tony);
    $this->tonyToken = $this->token;
    [, $this->somchaiToken] = loginAs($this->somchai);
});

function sendRaw($test, string $token, string $roomId, string $body): Message
{
    $res = $test->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'body' => $body,
    ], wsHeaders($token, 'acme'))->assertStatus(201);

    return Message::query()->findOrFail($res->json('data.message.id'));
}

// ---- FR-MSG-005 edit ----

test('TC-MSG-029 sender edits within window → 200, edited_at, edit_count, message_edits row, message.updated', function () {
    Event::fake([MessageUpdated::class]);
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'ห้อยังไม่ได้เบิกจ่าย');

    $res = $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'ห้องถูกเบิกจ่ายแล้ว'], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.message');

    expect($res['body'])->toBe('ห้องถูกเบิกจ่ายแล้ว')
        ->and($res['edit_count'])->toBe(1)
        ->and($res['edited_at'])->not->toBeNull();

    expect(MessageEdit::query()->where('message_id', $message->id)->count())->toBe(1)
        ->and(MessageEdit::query()->where('message_id', $message->id)->value('previous_body'))->toBe('ห้อยังไม่ได้เบิกจ่าย');

    Event::assertDispatched(MessageUpdated::class);
});

test('TC-MSG-030 someone else edits → 403', function () {
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'mine');

    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'hijack'], wsHeaders($this->somchaiToken, 'acme'))
        ->assertStatus(403);
});

test('TC-MSG-031 edit past the window → 422 MSG_EDIT_WINDOW_EXPIRED', function () {
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'old news');
    $message->forceFill(['created_at' => now()->subDays(2)])->save();

    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'too late'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_EDIT_WINDOW_EXPIRED');
});

test('editing a system message → 422 MSG_NOT_EDITABLE', function () {
    $system = Message::query()->create([
        'room_id' => $this->room->id,
        'workspace_id' => $this->ws->id,
        'sender_id' => null,
        'seq' => $this->room->last_seq + 1,
        'type' => 'system',
        'system_event' => ['event' => 'member_added'],
    ]);

    $this->patchJson("/api/v1/messages/{$system->id}", ['body' => 'nope'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_NOT_EDITABLE');
});

test('editing a deleted message → 422 MSG_NOT_EDITABLE', function () {
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'doomed');

    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);

    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'zombie'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_NOT_EDITABLE');
});

test('edit to empty body with no attachments → 422 MSG_EMPTY', function () {
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'text only');

    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => '   '], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_EMPTY');
});

test('edits are silent — no unread change, no room.activity', function () {
    $fake = [MessageUpdated::class, RoomActivity::class, WorkspaceUnreadChanged::class];
    Event::fake($fake);

    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'v1');

    Event::fake($fake); // re-fake → counters reset; only the edit's events count below

    $this->patchJson("/api/v1/messages/{$message->id}", ['body' => 'v2'], wsHeaders($this->tonyToken, 'acme'))->assertOk();

    Event::assertDispatchedTimes(MessageUpdated::class, 1);
    Event::assertNotDispatched(RoomActivity::class);
    Event::assertNotDispatched(WorkspaceUnreadChanged::class);
});

// ---- FR-MSG-006 delete ----

test('TC-MSG-037 sender deletes → 204, soft-deleted, seq kept, message.deleted broadcast', function () {
    Event::fake([MessageDeleted::class]);
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'oops');
    $seq = $message->seq;

    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(204);

    $row = Message::query()->findOrFail($message->id);
    expect($row->deleted_at)->not->toBeNull()
        ->and($row->body)->toBeNull()
        ->and($row->seq)->toBe($seq)
        ->and($row->delete_reason)->toBe('sender');

    Event::assertDispatched(MessageDeleted::class, fn (MessageDeleted $e) => $e->messageId === $message->id && $e->deleteReason === 'sender');
});

test('TC-MSG-040 repeat delete → 204 idempotent, single broadcast', function () {
    Event::fake([MessageDeleted::class]);
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'once');

    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);
    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);

    Event::assertDispatchedTimes(MessageDeleted::class, 1);
});

test('TC-MSG-041 room owner deletes a member message → moderator + audit row', function () {
    Event::fake([MessageDeleted::class]);
    $message = sendRaw($this, $this->somchaiToken, $this->room->id, 'member speak');

    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(204);

    expect(Message::query()->find($message->id)->delete_reason)->toBe('moderator')
        ->and(AuditLog::query()->where('action', 'message.deleted_moderator')->where('target_id', $message->id)->exists())->toBeTrue();

    Event::assertDispatched(MessageDeleted::class, fn (MessageDeleted $e) => $e->deleteReason === 'moderator');
});

test('plain member deleting another member message → 403', function () {
    $memberThree = User::factory()->create(['username' => 'anna']);
    $this->ws->members()->attach($memberThree->id, ['role' => 'member']);
    RoomMember::query()->create([
        'room_id' => $this->room->id, 'user_id' => $memberThree->id, 'workspace_id' => $this->ws->id,
        'role' => RoomRole::Member, 'added_by' => $this->tony->id,
    ]);
    $this->room->increment('member_count');
    [, $annaToken] = loginAs($memberThree);

    $message = sendRaw($this, $this->somchaiToken, $this->room->id, 'not yours');

    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($annaToken, 'acme'))
        ->assertStatus(403);
});

test('TC-MSG-042 deleting the last message → room preview falls back to the previous message', function () {
    sendRaw($this, $this->tonyToken, $this->room->id, 'older');
    $newest = sendRaw($this, $this->tonyToken, $this->room->id, 'newest');

    $this->deleteJson("/api/v1/messages/{$newest->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);

    $list = $this->getJson('/api/v1/rooms', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.0.last_message');

    expect($list['body'])->toBe('older');
});

test('deleted message renders as placeholder in history (body null, seq kept)', function () {
    $message = sendRaw($this, $this->tonyToken, $this->room->id, 'will vanish');
    $this->deleteJson("/api/v1/messages/{$message->id}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);

    $page = $this->getJson("/api/v1/rooms/{$this->room->id}/messages", wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.messages');

    $placeholder = collect($page)->first(fn ($m) => $m['id'] === $message->id);
    expect($placeholder)->not->toBeNull()
        ->and($placeholder['body'])->toBeNull()
        ->and($placeholder['deleted_at'])->not->toBeNull()
        ->and($placeholder['attachments'])->toBe([]);
});
