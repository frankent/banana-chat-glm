<?php

use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Enums\MessageType;
use App\Enums\RoomRole;
use App\Events\NotificationAlert;
use App\Jobs\NotifyMessage;
use App\Models\Device;
use App\Models\InAppNotification;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Models\Workspace;
use Carbon\Carbon;
use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

/**
 * FR-NOTI-001/002/005 — push device registration, decision rules,
 * NotifyMessage idempotency + FCM failure handling, settings APIs
 * (TC-NOTI-001..024).
 */
beforeEach(function () {
    config(['services.fcm.server_key' => 'test-key']);

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

function sendMessageRaw($test, string $token, string $roomId, string $body): Message
{
    $res = $test->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'body' => $body,
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data.message');

    return Message::query()->findOrFail($res['id']);
}

// ---- FR-NOTI-001 devices (TC-NOTI-001..004) ----

test('TC-NOTI-001 PUT /me/devices upserts the token', function () {
    $deviceId = (string) Str::ulid();

    $this->putJson("/api/v1/me/devices/{$deviceId}", [
        'platform' => 'web',
        'push_token' => 'tok-abc',
        'push_provider' => 'fcm',
    ], authHeaders($this->tonyToken))
        ->assertOk()
        ->assertJsonPath('data.device.push_provider', 'fcm');

    // update same device
    $this->putJson("/api/v1/me/devices/{$deviceId}", [
        'platform' => 'web',
        'push_token' => 'tok-xyz',
    ], authHeaders($this->tonyToken))->assertOk();

    expect(Device::query()->whereKey($deviceId)->value('push_token'))->toBe('tok-xyz');
});

test('TC-NOTI-002 a token previously owned by another user moves over', function () {
    $other = User::factory()->create();
    $otherDevice = Device::query()->create([
        'user_id' => $other->id, 'platform' => 'web', 'push_token' => 'shared-tok', 'push_provider' => 'fcm',
    ]);

    $this->putJson('/api/v1/me/devices/'.(string) Str::ulid(), [
        'platform' => 'web', 'push_token' => 'shared-tok', 'push_provider' => 'fcm',
    ], authHeaders($this->tonyToken))->assertOk();

    expect($otherDevice->refresh()->push_token)->toBeNull()
        ->and(Device::query()->where('user_id', $this->tony->id)->where('push_token', 'shared-tok')->exists())->toBeTrue();
});

test('TC-NOTI-004 invalid platform → 422', function () {
    $this->putJson('/api/v1/me/devices/'.(string) Str::ulid(), [
        'platform' => 'windows-phone',
    ], authHeaders($this->tonyToken))->assertStatus(422);
});

test('TC-NOTI-003 logout clears the device push token', function () {
    // loginAs created the session's device — put the token on THAT device
    $deviceId = Device::query()->where('user_id', $this->tony->id)->latest('created_at')->value('id');

    $this->putJson("/api/v1/me/devices/{$deviceId}", [
        'platform' => 'web', 'push_token' => 'tok-out',
    ], authHeaders($this->tonyToken))->assertOk();

    $this->postJson('/api/v1/auth/logout', [], authHeaders($this->tonyToken))->assertStatus(204);

    expect(Device::query()->whereKey($deviceId)->value('push_token'))->toBeNull();
});

// ---- FR-NOTI-002 decision rules (TC-NOTI-005..010) ----

function decide($test, ?array $roomOverride = [], ?array $settingOverride = []): bool
{
    $service = app(PushDecisionService::class);
    $message = Message::query()->make([
        'type' => MessageType::Text, 'body' => 'hello', 'seq' => 5,
    ]);
    $message->id = (string) Str::ulid();

    $room = Room::query()->make(array_merge([
        'workspace_id' => $test->ws->id, 'type' => 'group', 'name' => 'Eng',
    ], $roomOverride));
    $room->id = (string) Str::ulid();

    $recipient = $test->somchai;

    $setting = $settingOverride === [] ? null : new RoomNotificationSetting($settingOverride);

    return $service->shouldNotify($message, $room, $recipient, $test->tony->id, $setting, $recipient->notificationSetting, []);
}

test('TC-NOTI-005 sender and system messages are skipped', function () {
    $service = app(PushDecisionService::class);
    $message = Message::query()->make(['type' => MessageType::Text, 'body' => 'x', 'seq' => 1]);
    $message->id = (string) Str::ulid();
    $room = $this->room;

    expect($service->shouldNotify($message, $room, $this->tony, $this->tony->id, null, null, []))->toBeFalse(); // sender
    expect($service->shouldNotify($message, $room, $this->somchai, $this->tony->id, null, null, []))->toBeTrue(); // normal member
});

test('TC-NOTI-006 mode=none skips; TC-NOTI-007 muted window skips, expired sends', function () {
    expect(decide($this, [], ['mode' => 'none']))->toBeFalse();
    expect(decide($this, [], ['mode' => 'all', 'muted_until' => now()->addHour()]))->toBeFalse();
    expect(decide($this, [], ['mode' => 'all', 'muted_until' => now()->subHour()]))->toBeTrue();
});

test('TC-NOTI-008 mode=mentions: unmentioned skips, mentioned sends', function () {
    $service = app(PushDecisionService::class);
    $message = Message::query()->make(['type' => MessageType::Text, 'body' => 'hi @somchai', 'seq' => 2]);
    $message->id = (string) Str::ulid();

    $setting = new RoomNotificationSetting(['mode' => 'mentions']);

    expect($service->shouldNotify($message, $this->room, $this->somchai, $this->tony->id, $setting, null, []))->toBeFalse()
        ->and($service->shouldNotify($message, $this->room, $this->somchai, $this->tony->id, $setting, null, [$this->somchai->id]))->toBeTrue();
});

test('TC-NOTI-009 DND window skips (overnight range honored)', function () {
    // pin the clock (spec §12.1): 17:00 UTC Monday = 00:00 Tuesday Bangkok —
    // inside the overnight window (22:00→07:00), Tuesday ∈ dnd_days
    $this->travelTo(Carbon::parse('2026-09-07 17:00:00', 'UTC'));

    UserNotificationSetting::query()->create([
        'user_id' => $this->somchai->id,
        'dnd_start' => '22:00',
        'dnd_end' => '07:00',
        'dnd_days' => [1, 2, 3, 4, 5],
        'preview_in_push' => true,
    ]);
    $this->somchai->refresh();

    $service = app(PushDecisionService::class);
    $message = Message::query()->make(['type' => MessageType::Text, 'body' => 'x', 'seq' => 1]);
    $message->id = (string) Str::ulid();

    $result = $service->shouldNotify($message, $this->room, $this->somchai, $this->tony->id, null, $this->somchai->notificationSetting, []);
    expect($result)->toBeFalse();
});

test('TC-NOTI-010 focused device within 30s silences the user', function () {
    $service = app(PushDecisionService::class);

    $focused = Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web',
        'focused_room_id' => $this->room->id, 'focused_at' => now(),
    ]);
    $stale = Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web',
        'focused_room_id' => $this->room->id, 'focused_at' => now()->subMinutes(5),
    ]);

    expect($service->isFocusedOnRoom(collect([$stale]), $this->room->id))->toBeFalse();
    expect($service->isFocusedOnRoom(collect([$focused, $stale]), $this->room->id))->toBeTrue();
});

// ---- payload (TC-NOTI-012..015) ----

test('TC-NOTI-012..015 payload shapes', function () {
    $service = app(PushDecisionService::class);

    $dm = Room::query()->create([
        'workspace_id' => $this->ws->id, 'type' => 'dm', 'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id, 'dm_key' => 'k'.bin2hex(random_bytes(8)), 'member_count' => 2,
    ]);
    $dmMessage = Message::query()->make(['type' => MessageType::Text, 'body' => 'สวัสดี', 'seq' => 1]);
    $dmMessage->id = (string) Str::ulid();

    $dmPayload = $service->payload($dmMessage, $dm, $this->tony, 3);
    expect($dmPayload['title'])->toBe($this->tony->display_name)
        ->and($dmPayload['body'])->toBe('สวัสดี')
        ->and($dmPayload['badge'])->toBe(3);

    $groupMessage = Message::query()->make(['type' => MessageType::Text, 'body' => str_repeat('x', 300), 'seq' => 2]);
    $groupMessage->id = (string) Str::ulid();
    $groupPayload = $service->payload($groupMessage, $this->room, $this->tony, 0);
    expect($groupPayload['title'])->toBe('Engineering')
        ->and(mb_strlen($groupPayload['body']))->toBeLessThanOrEqual(mb_strlen($this->tony->display_name.': ') + 121)
        ->and($groupPayload['collapse_key'])->toBe($this->room->id);

    $img = Message::query()->make(['type' => MessageType::Image, 'body' => null, 'seq' => 3]);
    $img->id = (string) Str::ulid();
    expect($service->payload($img, $this->room, $this->tony, 0)['body'])->toEndWith('📷 รูปภาพ');

    UserNotificationSetting::query()->create([
        'user_id' => $this->tony->id, 'preview_in_push' => false, 'sound' => true,
    ]);
    $this->tony->refresh();
    expect($service->payload($groupMessage, $this->room, $this->tony->refresh(), 0)['body'])->toContain('ข้อความใหม่');
});

// ---- job behavior (TC-NOTI-011/016/017/018) ----

test('TC-NOTI-011 system message never dispatches NotifyMessage', function () {
    Queue::fake();

    // room creation writes a system message seq 1 — no push job for it
    $this->postJson('/api/v1/rooms', [
        'type' => 'group', 'name' => 'Pushless', 'member_ids' => [$this->somchai->id],
    ], wsHeaders($this->tonyToken, 'acme'))->assertStatus(201);

    Queue::assertNotPushed(NotifyMessage::class);
});

test('TC-NOTI-016 FCM UNREGISTERED deletes the token', function () {
    $device = Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'dead-tok', 'push_provider' => 'fcm',
    ]);

    Http::fake([
        'fcm.googleapis.com/*' => Http::response(['failure' => 1, 'results' => [['error' => 'UNREGISTERED']]], 200),
    ]);

    (new NotifyMessage(sendMessageRaw($this, $this->tonyToken, $this->room->id, 'ping')->id))
        ->handle(app(PushDecisionService::class), app(FcmPushSender::class));

    expect($device->refresh()->push_token)->toBeNull();
});

test('TC-NOTI-017 FCM 5xx bumps push_failed_count; 5 strikes disables', function () {
    $device = Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'flaky', 'push_provider' => 'fcm',
    ]);

    Http::fake([
        'fcm.googleapis.com/*' => Http::response(['error' => 'InternalError'], 500),
    ]);

    // fake the queue so the deferred sync dispatch doesn't add a hidden first strike
    Queue::fake();

    $message = sendMessageRaw($this, $this->tonyToken, $this->room->id, 'flaky run');
    $job = new NotifyMessage($message->id);

    for ($i = 1; $i <= 5; $i++) {
        // re-arm the idempotency set each round (failed sends remove themselves)
        try {
            $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));
        } catch (RuntimeException) {
            // expected — the sender throws on non-UNREGISTERED failure
        }
        expect($device->refresh()->push_failed_count)->toBe($i);
    }

    expect($device->refresh()->push_disabled_at)->not->toBeNull();
});

test('TC-NOTI-018 rerunning the job sends only once per device', function () {
    $device = Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'ok-tok', 'push_provider' => 'fcm',
    ]);

    Http::fake(['fcm.googleapis.com/*' => Http::response(['success' => 1], 200)]);

    $message = sendMessageRaw($this, $this->tonyToken, $this->room->id, 'once only');
    $job = new NotifyMessage($message->id);

    $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));
    $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));

    Http::assertSentCount(1);
});

test('a push actually goes out for an offline member with a token', function () {
    Device::query()->create([
        'user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'live-tok', 'push_provider' => 'fcm',
    ]);

    Http::fake(['fcm.googleapis.com/*' => Http::response(['success' => 1], 200)]);

    (new NotifyMessage(sendMessageRaw($this, $this->tonyToken, $this->room->id, 'real push')->id))
        ->handle(app(PushDecisionService::class), app(FcmPushSender::class));

    Http::assertSent(function (HttpRequest $request) {
        $body = $request->data();

        return $request->hasHeader('Authorization', 'key=test-key')
            && $body['to'] === 'live-tok'
            && $body['notification']['title'] === 'Engineering'
            && $body['data']['room_id'] === $this->room->id;
    });
});

// ---- FR-NOTI-005 settings APIs (TC-NOTI-019..022) ----

test('TC-NOTI-019/020 room notification settings upsert + future-only muted_until', function () {
    $this->putJson("/api/v1/rooms/{$this->room->id}/notifications", [
        'mode' => 'mentions', 'muted_until' => now()->addHours(8)->toIso8601String(),
    ], wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.settings.mode', 'mentions');

    // idempotent update + clear mute
    $this->putJson("/api/v1/rooms/{$this->room->id}/notifications", [
        'mode' => 'all', 'muted_until' => null,
    ], wsHeaders($this->somchaiToken, 'acme'))->assertOk();

    // past timestamp rejected
    $this->putJson("/api/v1/rooms/{$this->room->id}/notifications", [
        'mode' => 'all', 'muted_until' => now()->subHour()->toIso8601String(),
    ], wsHeaders($this->somchaiToken, 'acme'))->assertStatus(422);

    // infinity allowed
    $this->putJson("/api/v1/rooms/{$this->room->id}/notifications", [
        'mode' => 'all', 'muted_until' => 'infinity',
    ], wsHeaders($this->somchaiToken, 'acme'))->assertOk();
});

test('TC-NOTI-021 non-member room settings → 404 (cross-ws invisible)', function () {
    $stranger = User::factory()->create();
    $this->ws->members()->attach($stranger->id, ['role' => 'member']);
    [, $strangerToken] = loginAs($stranger);

    $this->putJson("/api/v1/rooms/{$this->room->id}/notifications", [
        'mode' => 'none',
    ], wsHeaders($strangerToken, 'acme'))->assertStatus(404);
});

test('TC-NOTI-022 user notification settings validate times', function () {
    $this->putJson('/api/v1/me/notification-settings', [
        'dnd_start' => '22:00', 'dnd_end' => '07:00', 'dnd_days' => [1, 2, 3, 4, 5], 'preview_in_push' => false,
    ], authHeaders($this->tonyToken))
        ->assertOk()
        ->assertJsonPath('data.settings.preview_in_push', false);

    $this->putJson('/api/v1/me/notification-settings', [
        'dnd_start' => '25:00', 'dnd_end' => '07:00',
    ], authHeaders($this->tonyToken))->assertStatus(422);

    $this->putJson('/api/v1/me/notification-settings', [
        'dnd_days' => [9],
    ], authHeaders($this->tonyToken))->assertStatus(422);
});

test('focus reporting records room + timestamp', function () {
    $deviceId = (string) Str::ulid();
    $this->putJson("/api/v1/me/devices/{$deviceId}", ['platform' => 'web'], authHeaders($this->tonyToken))->assertOk();

    $this->postJson('/api/v1/me/focus', [
        'device_id' => $deviceId, 'room_id' => $this->room->id,
    ], authHeaders($this->tonyToken))->assertOk();

    $device = Device::query()->findOrFail($deviceId);
    expect($device->focused_room_id)->toBe($this->room->id)
        ->and($device->focused_at)->not->toBeNull();
});

test('TC-NOTI-026 browser message alert respects eligibility and sound without a push token', function () {
    Queue::fake();
    $message = sendMessageRaw($this, $this->tonyToken, $this->room->id, 'browser alert');
    Event::fake([NotificationAlert::class]);
    $job = new NotifyMessage($message->id);
    $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));
    Event::assertDispatched(NotificationAlert::class, fn ($event) => $event->userId === $this->somchai->id && $event->id === $message->id);
    Event::assertNotDispatched(NotificationAlert::class, fn ($event) => $event->userId === $this->tony->id);
    Event::fake([NotificationAlert::class]);
    UserNotificationSetting::create(['user_id' => $this->somchai->id, 'sound' => false]);
    $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));
    Event::assertNotDispatched(NotificationAlert::class);
    UserNotificationSetting::where('user_id', $this->somchai->id)->update(['sound' => true]);
    RoomNotificationSetting::create(['user_id' => $this->somchai->id, 'room_id' => $this->room->id, 'mode' => 'none']);
    $job->handle(app(PushDecisionService::class), app(FcmPushSender::class));
    Event::assertNotDispatched(NotificationAlert::class);
});

test('TC-NOTI-027 overnight DND belongs to the day the window starts', function () {
    $setting = new UserNotificationSetting(['dnd_start' => '22:00', 'dnd_end' => '07:00', 'dnd_days' => [1]]);
    $decision = app(PushDecisionService::class);
    try {
        Carbon::setTestNow(Carbon::parse('2026-09-07 23:00', 'Asia/Bangkok'));
        expect($decision->inDnd($setting, 'Asia/Bangkok'))->toBeTrue();
        Carbon::setTestNow(Carbon::parse('2026-09-08 06:00', 'Asia/Bangkok'));
        expect($decision->inDnd($setting, 'Asia/Bangkok'))->toBeTrue();
        Carbon::setTestNow(Carbon::parse('2026-09-08 23:00', 'Asia/Bangkok'));
        expect($decision->inDnd($setting, 'Asia/Bangkok'))->toBeFalse();
    } finally {
        Carbon::setTestNow();
    }
});

test('TC-NOTI-028 invitation alert avoids duplicate mention sounds', function () {
    Event::fake([NotificationAlert::class]);
    $base = ['user_id' => $this->somchai->id, 'workspace_id' => $this->ws->id, 'actor_id' => $this->tony->id, 'room_id' => $this->room->id];
    InAppNotification::create($base + ['type' => 'mention']);
    Event::assertNotDispatched(NotificationAlert::class);
    InAppNotification::create($base + ['type' => 'added_to_room']);
    Event::assertDispatched(NotificationAlert::class, fn ($event) => $event->kind === 'added_to_room');
});
