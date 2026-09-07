<?php

use App\Domain\Auth\TokenService;
use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Enums\RoomRole;
use App\Jobs\NotifyMessage;
use App\Models\InAppNotification;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * FR-NOTI-006 / API-073 — in-app notification center.
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

    foreach ([[$this->tony, RoomRole::Owner], [$this->somchai, RoomRole::Member]] as [$user, $role]) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $role,
            'added_by' => $this->tony->id,
        ]);
    }

    [, $this->tonyToken] = loginAs($this->tony);
    [, $this->somchaiToken] = loginAs($this->somchai);
});

// ---- feed + mark read (API-073) ----

test('feed lists newest first with actor shape; other users see nothing', function () {
    $old = InAppNotification::query()->create([
        'user_id' => $this->somchai->id,
        'workspace_id' => $this->ws->id,
        'type' => 'mention',
        'room_id' => $this->room->id,
        'actor_id' => $this->tony->id,
        'data' => ['message_id' => '01ABC', 'seq' => 12, 'snippet' => 'hello'],
        'created_at' => now()->subHour(),
    ]);
    $new = InAppNotification::query()->create([
        'user_id' => $this->somchai->id,
        'workspace_id' => null,
        'type' => 'session_revoked',
        'data' => ['session_id' => '01SESS', 'reason' => 'admin'],
    ]);

    $res = $this->getJson('/api/v1/me/notifications', wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->json('data.notifications');

    expect($res)->toHaveCount(2)
        ->and($res[0]['id'])->toBe($new->id)
        ->and($res[1]['id'])->toBe($old->id)
        ->and($res[1]['actor']['username'])->toBe('tony')
        ->and($res[0]['actor'])->toBeNull()
        ->and($res[1]['data']['snippet'])->toBe('hello');

    $this->getJson('/api/v1/me/notifications', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->assertJsonCount(0, 'data.notifications');
});

test('mark read with ids marks only those; empty body marks all unread', function () {
    $a = InAppNotification::query()->create(['user_id' => $this->somchai->id, 'workspace_id' => $this->ws->id, 'type' => 'mention', 'room_id' => $this->room->id, 'actor_id' => $this->tony->id, 'data' => []]);
    $b = InAppNotification::query()->create(['user_id' => $this->somchai->id, 'workspace_id' => $this->ws->id, 'type' => 'added_to_room', 'room_id' => $this->room->id, 'actor_id' => $this->tony->id, 'data' => []]);

    $this->postJson('/api/v1/me/notifications/read', ['ids' => [$a->id]], wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk();

    expect($a->fresh()->read_at)->not->toBeNull()
        ->and($b->fresh()->read_at)->toBeNull();

    $this->postJson('/api/v1/me/notifications/read', [], wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk();

    expect($b->fresh()->read_at)->not->toBeNull();
});

// ---- creator wiring: mention ----

test('a mention creates a feed row for the mentioned user, not the sender', function () {
    Http::fake(); // no real FCM
    Queue::fake();

    $message = Message::query()->create([
        'room_id' => $this->room->id,
        'workspace_id' => $this->ws->id,
        'sender_id' => $this->tony->id,
        'seq' => 1,
        'type' => 'text',
        'body' => 'hey @somchai check this',
        'client_message_id' => (string) Str::uuid(),
    ]);
    DB::table('message_mentions')->insert([
        'message_id' => $message->id,
        'user_id' => $this->somchai->id,
        'workspace_id' => $this->ws->id,
    ]);

    (new NotifyMessage($message->id))->handle(app(PushDecisionService::class), app(FcmPushSender::class));

    $rows = InAppNotification::query()->where('user_id', $this->somchai->id)->get();

    expect($rows)->toHaveCount(1)
        ->and($rows[0]->type)->toBe('mention')
        ->and($rows[0]->actor_id)->toBe($this->tony->id)
        ->and($rows[0]->room_id)->toBe($this->room->id)
        ->and($rows[0]->data['message_id'])->toBe($message->id)
        ->and(InAppNotification::query()->where('user_id', $this->tony->id)->count())->toBe(0);
});

// ---- creator wiring: added to room ----

test('addMembers creates added_to_room rows except for the adder', function () {
    $newcomer = User::factory()->create(['username' => 'newbie']);
    $this->ws->members()->attach($newcomer->id, ['role' => 'member']);

    $this->postJson("/api/v1/rooms/{$this->room->id}/members", ['user_ids' => [$newcomer->id]], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk();

    $row = InAppNotification::query()->where('user_id', $newcomer->id)->first();

    expect($row)->not->toBeNull()
        ->and($row->type)->toBe('added_to_room')
        ->and($row->actor_id)->toBe($this->tony->id)
        ->and($row->data['room_name'])->toBe('Engineering')
        // somchai was already a member (already=1) → no row for them either
        ->and(InAppNotification::query()->where('user_id', $this->somchai->id)->count())->toBe(0)
        ->and(InAppNotification::query()->where('user_id', $this->tony->id)->count())->toBe(0);
});

// ---- creator wiring: session revoked ----

test('admin revoke creates a session_revoked row; self-logout does not', function () {
    $tokens = app(TokenService::class);
    $session = $this->somchai->sessions()->first();

    $tokens->revokeSession($session, 'admin', false);

    expect(InAppNotification::query()->where('user_id', $this->somchai->id)->where('type', 'session_revoked')->count())
        ->toBe(1);

    // a fresh login → a second live session; revoking it as self-logout
    // must NOT add a feed row (routine logout is not security-relevant)
    loginAs($this->somchai, ['platform' => 'web', 'name' => 'Second device']);
    $fresh = $this->somchai->sessions()->whereNull('revoked_at')->first();
    $tokens->revokeSession($fresh, 'logout', false);

    expect(InAppNotification::query()->where('user_id', $this->somchai->id)->where('type', 'session_revoked')->count())
        ->toBe(1);
});
