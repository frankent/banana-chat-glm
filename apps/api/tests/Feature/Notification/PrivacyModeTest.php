<?php

use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PrivacyMasker;
use App\Domain\Notification\PushDecisionService;
use App\Enums\MessageType;
use App\Enums\PublicChatStatus;
use App\Enums\RoomRole;
use App\Events\NotificationAlert;
use App\Events\UserSettingsUpdated;
use App\Jobs\NotifyMessage;
use App\Models\ChatSession;
use App\Models\Device;
use App\Models\InAppNotification;
use App\Models\Message;
use App\Models\PublicChatRoom;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Models\Workspace;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * FR-NOTI-008 (masked notifications) / FR-NOTI-009 + API-236 (app lock,
 * server half) / DEC-087 — TC-NOTI-040..053, TC-AUTH-039..043.
 */
function privacyFcmKey(): string
{
    static $pem = null;
    if ($pem === null) {
        $res = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($res, $pem);
    }

    return $pem;
}

beforeEach(function () {
    config([
        'services.fcm.project_id' => 'test-project',
        'services.fcm.credentials' => json_encode([
            'client_email' => 'push@test-project.iam.gserviceaccount.com',
            'private_key' => privacyFcmKey(),
            'token_uri' => 'https://oauth2.googleapis.com/token',
        ]),
    ]);

    $this->tony = User::factory()->create(['username' => 'tony', 'display_name' => 'Tony Secretname']);
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

function privacyOn(User $user): void
{
    UserNotificationSetting::query()->updateOrCreate(
        ['user_id' => $user->id],
        ['privacy_mode' => true],
    );
    $user->refresh();
}

function privacyFcmFake(): void
{
    Http::fake([
        'oauth2.googleapis.com/*' => Http::response(['access_token' => 'tok', 'expires_in' => 3600]),
        'fcm.googleapis.com/*' => Http::response(['name' => 'projects/test-project/messages/1'], 200),
    ]);
}

/**
 * @return list<array{title: string, body: string, data: array<string, mixed>}> the sent FCM message bodies
 */
function privacySentFcmMessages(): array
{
    return collect(Http::recorded())
        ->filter(fn ($pair) => str_contains($pair[0]->url(), 'fcm.googleapis.com'))
        ->map(fn ($pair) => $pair[0]->data()['message'])
        ->values()
        ->all();
}

function privacySendText(string $token, string $roomId, string $body): Message
{
    $res = test()->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'body' => $body,
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data.message');

    return Message::query()->findOrFail($res['id']);
}

function privacyMakeMessage(array $overrides = []): Message
{
    $seq = (int) (Message::query()->where('room_id', test()->room->id)->max('seq') ?? 0) + 1;

    return Message::query()->create(array_merge([
        'room_id' => test()->room->id,
        'workspace_id' => test()->ws->id,
        'sender_id' => test()->tony->id,
        'seq' => $seq,
        'type' => MessageType::Text,
        'body' => 'SECRET-PLAN-9',
        'client_message_id' => (string) Str::uuid(),
    ], $overrides));
}

function privacyRunJob(Message $message): void
{
    (new NotifyMessage($message->id))->handle(app(PushDecisionService::class), app(FcmPushSender::class));
}

// ---- TC-NOTI-040: masked text push, both locales ----

test('TC-NOTI-040 privacy mode masks a text push in the recipient locale (th)', function () {
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
    privacyOn($this->somchai);

    privacyFcmFake();
    $message = privacySendText($this->tonyToken, $this->room->id, 'SECRET-PLAN-9 launch tonight');
    privacyRunJob($message);

    $messages = privacySentFcmMessages();
    expect($messages)->toHaveCount(1);
    $m = $messages[0];

    expect($m['webpush']['notification']['title'])->toBe('Banana Chat')
        ->and($m['webpush']['notification']['body'])->toBe('ข้อความใหม่')
        // deep-link routing ids survive — they are opaque ULIDs
        ->and($m['data']['room_id'])->toBe($this->room->id)
        ->and($m['data']['message_id'])->toBe($message->id)
        // grouping survives
        ->and($m['webpush']['notification']['tag'])->toBe($this->room->id)
        ->and($m['webpush']['headers']['Topic'])->toBe($this->room->id);
});

test('TC-NOTI-040 en-locale recipient gets the English generic line', function () {
    $this->somchai->forceFill(['locale' => 'en'])->save();
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
    privacyOn($this->somchai);

    privacyFcmFake();
    privacyRunJob(privacySendText($this->tonyToken, $this->room->id, 'SECRET-PLAN-9 launch tonight'));

    expect(privacySentFcmMessages()[0]['webpush']['notification']['body'])->toBe('New message');
});

// ---- TC-NOTI-041..043: media kinds ----

test('TC-NOTI-041/042/043 image, video and file pushes mask by kind', function () {
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
    privacyOn($this->somchai);
    privacyFcmFake();

    privacyRunJob(privacyMakeMessage(['type' => MessageType::Image, 'body' => null]));
    privacyRunJob(privacyMakeMessage(['type' => MessageType::Video, 'body' => null]));
    privacyRunJob(privacyMakeMessage(['type' => MessageType::File, 'body' => null]));

    $bodies = array_map(fn ($m) => $m['webpush']['notification']['body'], privacySentFcmMessages());

    expect($bodies)->toBe(['รูปภาพใหม่', 'วิดีโอใหม่', 'ไฟล์ใหม่']);
});

// ---- TC-NOTI-044: call ----

test('TC-NOTI-044 the call generic line exists for both locales and the ringing alert stays content-free', function () {
    $masker = new PrivacyMasker;

    // the full kind × locale table the client and server must agree on
    expect($masker->body('message', 'th'))->toBe('ข้อความใหม่')
        ->and($masker->body('photo', 'th'))->toBe('รูปภาพใหม่')
        ->and($masker->body('video', 'th'))->toBe('วิดีโอใหม่')
        ->and($masker->body('file', 'th'))->toBe('ไฟล์ใหม่')
        ->and($masker->body('call', 'th'))->toBe('สายเรียกเข้า')
        ->and($masker->body('mention', 'th'))->toBe('มีการกล่าวถึงคุณ')
        ->and($masker->body('message', 'en'))->toBe('New message')
        ->and($masker->body('photo', 'en'))->toBe('New photo')
        ->and($masker->body('video', 'en'))->toBe('New video')
        ->and($masker->body('file', 'en'))->toBe('New file')
        ->and($masker->body('call', 'en'))->toBe('Incoming call')
        ->and($masker->body('mention', 'en'))->toBe('You were mentioned')
        ->and($masker->title())->toBe('Banana Chat');

    // unknown locale defaults to th; unknown kind degrades to the message line
    expect($masker->body('call', null))->toBe('สายเรียกเข้า')
        ->and($masker->body('nonsense', 'en'))->toBe('New message');

    // The ringing broadcast (the only "call notification" the server builds —
    // there is no FCM ringing push) must stay content-free with privacy on:
    // masking changes what a notification SAYS, never whether it fires.
    config(['calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32), 'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880']);
    Http::fake(['*/twirp/*' => Http::response([])]);
    privacyOn($this->somchai);

    \Illuminate\Support\Facades\Event::fake([NotificationAlert::class]);

    $call = $this->postJson("/api/v1/rooms/{$this->room->id}/calls", ['kind' => 'video'], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(200)->json('data');

    \Illuminate\Support\Facades\Event::assertDispatched(NotificationAlert::class, function (NotificationAlert $e) use ($call) {
        return $e->userId === $this->somchai->id
            && $e->id === $call['id']
            && $e->roomId === $this->room->id
            && $e->kind === 'call'
            && $e->sound === true;
    });
});

// ---- TC-NOTI-045: mention ----

test('TC-NOTI-045 a mention push says "you were mentioned" and the feed row carries no snippet', function () {
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
    privacyOn($this->somchai);

    $message = privacySendText($this->tonyToken, $this->room->id, 'hey @somchai SECRET-PLAN-9');
    // the writer already parsed "@somchai" into a message_mentions row

    privacyFcmFake();
    privacyRunJob($message);

    $m = privacySentFcmMessages()[0];
    expect($m['webpush']['notification']['body'])->toBe('มีการกล่าวถึงคุณ');

    // locale change with privacy still on → the English mention line
    $this->somchai->forceFill(['locale' => 'en'])->save();
    $this->somchai->refresh();

    $message2 = privacySendText($this->tonyToken, $this->room->id, 'again @somchai SECRET-PLAN-9');
    privacyRunJob($message2);

    expect(privacySentFcmMessages()[1]['webpush']['notification']['body'])->toBe('You were mentioned');

    // the mention feed row for the privacy-on send stored no snippet copy
    $rows = InAppNotification::query()->where('user_id', $this->somchai->id)->where('type', 'mention')->get();
    $row = $rows->first(fn (InAppNotification $n) => ($n->data['message_id'] ?? null) === $message->id);
    expect($row)->not->toBeNull()
        ->and($row->data)->not->toHaveKey('snippet')
        ->and($row->data['message_id'])->toBe($message->id);
});

// ---- TC-NOTI-046: recipient vs sender (DEC-076 inversion guard) ----

test('TC-NOTI-046 privacy mode is read off the RECIPIENT, never the sender', function () {
    $service = app(PushDecisionService::class);
    $message = privacyMakeMessage();

    // recipient on, sender off → masked
    UserNotificationSetting::query()->create(['user_id' => $this->somchai->id, 'privacy_mode' => true, 'preview_in_push' => true]);
    $masked = $service->payload($message, $this->room, $this->tony, 0, $this->somchai->refresh());
    expect($masked['title'])->toBe('Banana Chat')
        ->and($masked['body'])->toBe('ข้อความใหม่');

    // reverse: sender on, recipient off → NOT masked (this was the DEC-076 bug shape)
    UserNotificationSetting::query()->where('user_id', $this->somchai->id)->update(['privacy_mode' => false]);
    UserNotificationSetting::query()->updateOrCreate(['user_id' => $this->tony->id], ['privacy_mode' => true]);
    $clear = $service->payload($message, $this->room, $this->tony->refresh(), 0, $this->somchai->refresh());
    expect($clear['title'])->toBe('Engineering')
        ->and($clear['body'])->toBe('Tony Secretname: SECRET-PLAN-9');
});

// ---- TC-NOTI-047: nothing leaks through ANY FCM sub-block ----

test('TC-NOTI-047 no message text, room name or sender name appears anywhere in the serialized masked push', function () {
    // one web + one native device: the web shape renders webpush.notification,
    // the native shape renders message.notification + apns alert + data copies
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'ios', 'push_token' => 'ios-tok', 'push_provider' => 'fcm']);
    privacyOn($this->somchai);

    privacyFcmFake();
    privacyRunJob(privacySendText($this->tonyToken, $this->room->id, 'SECRET-PLAN-9 launch tonight'));

    $messages = privacySentFcmMessages();
    expect($messages)->toHaveCount(2);

    foreach ($messages as $m) {
        $json = (string) json_encode($m);

        expect($json)->not->toContain('SECRET-PLAN-9')
            ->not->toContain('Engineering')
            ->not->toContain('Tony Secretname')
            ->toContain('Banana Chat');
    }

    $ios = collect($messages)->first(fn ($m) => ($m['token'] ?? '') === 'ios-tok');
    expect($ios['notification'])->toBe(['title' => 'Banana Chat', 'body' => 'ข้อความใหม่'])
        ->and($ios['apns']['payload']['aps']['alert'])->toBe(['title' => 'Banana Chat', 'body' => 'ข้อความใหม่'])
        ->and($ios['data']['title'])->toBe('Banana Chat')
        ->and($ios['data']['body'])->toBe('ข้อความใหม่')
        // opaque routing ids stay
        ->and($ios['data']['room_id'])->toBe($this->room->id)
        // grouping keys stay and are pinned to EQUAL the room id (opaque
        // ULID, not a readable room name) — absence fails, not just leakage
        ->and($ios['android']['collapse_key'])->toBe($this->room->id)
        ->and($ios['android']['notification']['tag'])->toBe($this->room->id);
});

// ---- TC-NOTI-048: default (off) behaviour unchanged ----

test('TC-NOTI-048 privacy off keeps the historic payload; preview_in_push keeps its own narrower behaviour', function () {
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);

    privacyFcmFake();
    privacyRunJob(privacySendText($this->tonyToken, $this->room->id, 'plain visibility'));

    $m = privacySentFcmMessages()[0];
    expect($m['webpush']['notification']['title'])->toBe('Engineering')
        ->and($m['webpush']['notification']['body'])->toBe('Tony Secretname: plain visibility');

    // explicit privacy_mode=false row is also unmasked
    UserNotificationSetting::query()->create(['user_id' => $this->somchai->id, 'privacy_mode' => false, 'preview_in_push' => true]);
    $this->somchai->refresh();
    privacyRunJob(privacyMakeMessage(['body' => 'still visible']));

    expect(privacySentFcmMessages()[1]['webpush']['notification']['body'])->toBe('Tony Secretname: still visible');

    // the superset boundary: privacy off + preview off → generic body but the
    // title (room name) and the group sender prefix are STILL shown — exactly
    // the old behaviour; privacy mode is what additionally strips them
    UserNotificationSetting::query()->where('user_id', $this->somchai->id)->update(['privacy_mode' => false, 'preview_in_push' => false]);
    $this->somchai->refresh();
    privacyRunJob(privacyMakeMessage(['body' => 'hidden preview']));

    $m3 = privacySentFcmMessages()[2]['webpush']['notification'];
    expect($m3['title'])->toBe('Engineering')
        ->and($m3['body'])->toBe('Tony Secretname: ข้อความใหม่');
});

// ---- TC-NOTI-049: settings round trip ----

test('TC-NOTI-049 privacy_mode round-trips through API-072 and surfaces in GET /me', function () {
    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => true], authHeaders($this->somchaiToken))
        ->assertOk()
        ->assertJsonPath('data.settings.privacy_mode', true);

    $this->getJson('/api/v1/me', authHeaders($this->somchaiToken))
        ->assertOk()
        ->assertJsonPath('data.settings.notification.privacy_mode', true);

    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => false], authHeaders($this->somchaiToken))
        ->assertOk()
        ->assertJsonPath('data.settings.privacy_mode', false);

    // invalid type rejected
    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => 'yes'], authHeaders($this->somchaiToken))
        ->assertStatus(422);
});

// ---- TC-NOTI-050: in-app feed rows created while privacy is on carry no content ----

test('TC-NOTI-050 added_to_room feed row withholds the room name for a privacy-mode user', function () {
    $newbie = User::factory()->create();
    $this->ws->members()->attach($newbie->id, ['role' => 'member']);
    privacyOn($newbie);

    $this->postJson("/api/v1/rooms/{$this->room->id}/members", ['user_ids' => [$newbie->id]], wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(200);

    $row = InAppNotification::query()->where('user_id', $newbie->id)->where('type', 'added_to_room')->first();
    expect($row->data)->not->toHaveKey('room_name')
        ->and($row->room_id)->toBe($this->room->id);
});

// ---- TC-NOTI-051: the desktop alert carries the real message kind ----

test('TC-NOTI-051 NotificationAlert kind follows the message: photo and mention, not always message', function () {
    \Illuminate\Support\Facades\Event::fake([NotificationAlert::class]);

    // a message that mentions the recipient: kind mention (via the API so the
    // writer stamps the room's denormalised seq counter — a direct insert
    // first would make the next API send collide on (room_id, seq))
    $message = privacySendText($this->tonyToken, $this->room->id, 'hey @somchai SECRET-PLAN-9');
    privacyRunJob($message);

    \Illuminate\Support\Facades\Event::assertDispatched(NotificationAlert::class,
        fn (NotificationAlert $e) => $e->userId === $this->somchai->id && $e->id === $message->id && $e->kind === 'mention');

    // a media-only message: the popup must be able to say "New photo"
    privacyRunJob(privacyMakeMessage(['type' => MessageType::Image, 'body' => null]));

    \Illuminate\Support\Facades\Event::assertDispatched(NotificationAlert::class,
        fn (NotificationAlert $e) => $e->userId === $this->somchai->id && $e->kind === 'photo');
});

// ---- TC-NOTI-052: privacy toggle reaches the user's other open clients ----

test('TC-NOTI-052 changing privacy_mode broadcasts one content-free user.updated nudge; other PUTs stay silent', function () {
    \Illuminate\Support\Facades\Event::fake([UserSettingsUpdated::class]);

    // sound-only PUT: no privacy delta → no broadcast
    $this->putJson('/api/v1/me/notification-settings', ['sound' => false], authHeaders($this->somchaiToken))
        ->assertOk();
    \Illuminate\Support\Facades\Event::assertNotDispatched(UserSettingsUpdated::class);

    // the actual toggle → exactly one broadcast ...
    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => true], authHeaders($this->somchaiToken))
        ->assertOk();
    \Illuminate\Support\Facades\Event::assertDispatchedTimes(UserSettingsUpdated::class, 1);

    // ... on the user's private channel, carrying no privacy value or PII
    \Illuminate\Support\Facades\Event::assertDispatched(UserSettingsUpdated::class, function (UserSettingsUpdated $e) {
        expect($e->broadcastOn())->toEqual([new PrivateChannel('user.'.$this->somchai->id)])
            ->and($e->broadcastWith()['data'])->toBe([])
            ->and((string) json_encode($e->broadcastWith()))
                ->not->toContain('privacy')
                ->not->toContain('somchai')
                ->not->toContain('true');

        return true;
    });

    // re-sending the same value is not a change → still exactly one overall
    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => true], authHeaders($this->somchaiToken))
        ->assertOk();
    \Illuminate\Support\Facades\Event::assertDispatchedTimes(UserSettingsUpdated::class, 1);

    // toggling back off broadcasts again (2 total)
    $this->putJson('/api/v1/me/notification-settings', ['privacy_mode' => false], authHeaders($this->somchaiToken))
        ->assertOk();
    \Illuminate\Support\Facades\Event::assertDispatchedTimes(UserSettingsUpdated::class, 2);
});

// ---- public chat agent push (FR-NOTI-008 on the FR-PCHAT-015 path) ----

test('TC-NOTI-053 a public-chat visitor push to a privacy-mode agent shows no customer name or message text', function () {
    app(\App\Services\SettingsService::class)->set('publicchat.enabled', true); // DEC-071 ships OFF
    privacyOn($this->somchai);
    Device::query()->create(['user_id' => $this->somchai->id, 'platform' => 'web', 'push_token' => 'agent-tok', 'push_provider' => 'fcm']);

    $room = PublicChatRoom::withoutGlobalScopes()->create([
        'workspace_id' => $this->ws->id,
        'code' => PublicChatRoom::generateCode(),
        'customer_name' => 'VIP-CUSTOMER-NAME',
        'provider_name' => 'ACME Support',
        'status' => PublicChatStatus::InProgress->value,
        'locale' => 'th',
        'expires_at' => now()->addDays(30),
        'assigned_to' => $this->somchai->id,
    ]);

    $messageId = $this->postJson('/api/v1/public-chat/'.$room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(), 'body' => 'SECRET-VISITOR-TEXT',
    ])->json('message.id');
    expect($messageId)->not->toBeNull();

    privacyFcmFake();
    \Illuminate\Support\Facades\Event::fake([NotificationAlert::class]);
    app()->call([new \App\Domain\PublicChat\NotifyPublicChatMessage($messageId), 'handle']);

    $messages = privacySentFcmMessages();
    expect($messages)->toHaveCount(1);
    $m = $messages[0];

    expect($m['webpush']['notification']['title'])->toBe('Banana Chat')
        ->and($m['webpush']['notification']['body'])->toBe('ข้อความใหม่')
        ->and((string) json_encode($m))->not->toContain('SECRET-VISITOR-TEXT')
        ->not->toContain('VIP-CUSTOMER-NAME')
        ->and($m['data']['public_chat_room_id'])->toBe($room->id);
});

// ---- API-236 / FR-NOTI-009 — POST /me/verify-password (TC-AUTH-039..043) ----

test('TC-AUTH-039 correct password → 204 and every other session/token stays valid', function () {
    [, $otherDeviceToken] = loginAs($this->somchai, ['platform' => 'web', 'name' => 'Other Device']);
    $sessionsBefore = ChatSession::query()->where('user_id', $this->somchai->id)->whereNull('revoked_at')->count();

    $this->postJson('/api/v1/me/verify-password', ['password' => 'Password123!'], authHeaders($this->somchaiToken))
        ->assertNoContent();

    // no revocation, no rotation: both tokens still authenticate
    $this->getJson('/api/v1/me', authHeaders($this->somchaiToken))->assertOk();
    $this->getJson('/api/v1/me', authHeaders($otherDeviceToken))->assertOk();
    expect(ChatSession::query()->where('user_id', $this->somchai->id)->whereNull('revoked_at')->count())->toBe($sessionsBefore);
});

test('TC-AUTH-040 wrong password → 422 INVALID_PASSWORD, session untouched', function () {
    $res = $this->postJson('/api/v1/me/verify-password', ['password' => 'WrongPassword!'], authHeaders($this->somchaiToken))
        ->assertStatus(422);

    expect($res->json('error.code'))->toBe('INVALID_PASSWORD');

    // a failed check must not log the user out either
    $this->getJson('/api/v1/me', authHeaders($this->somchaiToken))->assertOk();
});

test('TC-AUTH-041 verify-password is rate limited at 8/min per user', function () {
    for ($i = 0; $i < 8; $i++) {
        $this->postJson('/api/v1/me/verify-password', ['password' => 'guess-'.$i], authHeaders($this->somchaiToken))
            ->assertStatus(422);
    }

    $this->postJson('/api/v1/me/verify-password', ['password' => 'Password123!'], authHeaders($this->somchaiToken))
        ->assertStatus(429);
});

test('TC-AUTH-042 unauthenticated → 401; missing password → 422', function () {
    $this->postJson('/api/v1/me/verify-password', ['password' => 'Password123!'])->assertStatus(401);

    $this->postJson('/api/v1/me/verify-password', [], authHeaders($this->somchaiToken))->assertStatus(422);
});

test('TC-AUTH-043 a must-change-password account can still verify (outside password.fresh)', function () {
    $this->somchai->forceFill(['must_change_password' => true])->save();

    $this->postJson('/api/v1/me/verify-password', ['password' => 'Password123!'], authHeaders($this->somchaiToken))
        ->assertNoContent();
});
