<?php

use App\Domain\Calls\CallService;
use App\Domain\Notification\CallPush;
use App\Events\CallChanged;
use App\Events\NotificationAlert;
use App\Jobs\NotifyIncomingCall;
use App\Jobs\NotifyMissedCall;
use App\Models\CallParticipant;
use App\Models\Device;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use App\Models\UserNotificationSetting;
use App\Models\Workspace;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;

/**
 * FR-NOTI-010 / DEC-095 — closed-app ringing push for a 1-to-1 call,
 * TC-NOTI-054..063. Helper names are prefixed `ring`: Pest helpers are global.
 */
function ringFcmKey(): string
{
    static $pem = null;
    if ($pem === null) {
        $res = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($res, $pem);
    }

    return $pem;
}

/** @return list<array<string, mixed>> the FCM message bodies sent so far */
function ringSent(): array
{
    return collect(Http::recorded())
        ->filter(fn ($pair) => str_contains($pair[0]->url(), 'fcm.googleapis.com'))
        ->map(fn ($pair) => $pair[0]->data()['message'])
        ->values()
        ->all();
}

function ringJoin(RoomCall $call, User $user): CallParticipant
{
    return CallParticipant::create([
        'call_id' => $call->id, 'user_id' => $user->id,
        'session_id' => DB::table('sessions')->where('user_id', $user->id)->value('id'),
    ]);
}

function ringTick(RoomCall $call, User $to, int $tick = 0): void
{
    (new NotifyIncomingCall($call->id, $to->id, $tick))->handle(app(CallPush::class), app(CallService::class));
}

beforeEach(function () {
    Event::fake([CallChanged::class, NotificationAlert::class]);
    config([
        'calls.enabled' => true, 'calls.key' => 'testkey', 'calls.secret' => str_repeat('a', 32),
        'calls.url' => 'wss://chat.example', 'calls.internal_url' => 'http://media:7880',
        'app.url' => 'https://chat.example',
        'services.fcm.project_id' => 'test-project',
        'services.fcm.credentials' => json_encode([
            'client_email' => 'push@test-project.iam.gserviceaccount.com',
            'private_key' => ringFcmKey(),
            'token_uri' => 'https://oauth2.googleapis.com/token',
        ]),
    ]);
    Cache::flush();
    Http::fake([
        'oauth2.googleapis.com/*' => Http::response(['access_token' => 'tok', 'expires_in' => 3600]),
        'fcm.googleapis.com/*' => Http::response(['name' => 'projects/test-project/messages/1'], 200),
        '*' => Http::response([], 200),
    ]);

    $this->caller = User::factory()->create(['display_name' => 'Caller Secretname']);
    $this->callee = User::factory()->create(['locale' => 'th']);
    $this->third = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'ring']);
    foreach ([$this->caller, $this->callee, $this->third] as $u) {
        $this->ws->members()->attach($u->id, ['role' => 'member']);
    }
    $this->dm = Room::create(['workspace_id' => $this->ws->id, 'type' => 'dm', 'created_by' => $this->caller->id, 'member_count' => 2]);
    foreach ([$this->caller, $this->callee] as $u) {
        $this->dm->members()->attach($u->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    }
    [, $t] = loginAs($this->caller);
    $this->callerH = wsHeaders($t, 'ring');
    [, $t] = loginAs($this->callee);
    $this->calleeH = wsHeaders($t, 'ring');
    $this->webDevice = Device::query()->create(['user_id' => $this->callee->id, 'platform' => 'web', 'push_token' => 'web-tok', 'push_provider' => 'fcm']);
});

function ringStart($test, string $kind = 'video'): RoomCall
{
    $id = $test->postJson('/api/v1/rooms/'.$test->dm->id.'/calls', ['kind' => $kind], $test->callerH)->assertOk()->json('data.id');

    return RoomCall::findOrFail($id);
}

test('TC-NOTI-054 a new 1-to-1 call queues the ring for the callee only; groups, muted and sound-off callees get none', function () {
    Queue::fake();
    $call = ringStart($this);
    Queue::assertPushed(NotifyIncomingCall::class, fn ($j) => $j->recipientId === $this->callee->id && $j->callId === $call->id && $j->tick === 0);
    Queue::assertPushed(NotifyIncomingCall::class, 1);

    // a repeat start returns the existing call and rings nothing new
    $this->postJson('/api/v1/rooms/'.$this->dm->id.'/calls', ['kind' => 'video'], $this->callerH)->assertOk();
    Queue::assertPushed(NotifyIncomingCall::class, 1);
});

test('TC-NOTI-054 muted room and sound-off callee are not pushed; group calls never ring-push', function () {
    Queue::fake();
    RoomNotificationSetting::create(['user_id' => $this->callee->id, 'room_id' => $this->dm->id, 'mode' => 'none']);
    ringStart($this);
    Queue::assertNotPushed(NotifyIncomingCall::class);

    RoomNotificationSetting::query()->delete();
    RoomCall::query()->update(['ended_at' => now()]);
    UserNotificationSetting::create(['user_id' => $this->callee->id, 'sound' => false]);
    ringStart($this);
    Queue::assertNotPushed(NotifyIncomingCall::class);

    UserNotificationSetting::query()->delete();
    RoomCall::query()->update(['ended_at' => now()]);
    $group = Room::create(['workspace_id' => $this->ws->id, 'type' => 'group', 'name' => 'G', 'created_by' => $this->caller->id, 'member_count' => 3]);
    foreach ([$this->caller, $this->callee, $this->third] as $u) {
        $group->members()->attach($u->id, ['workspace_id' => $this->ws->id, 'role' => 'member']);
    }
    $this->postJson('/api/v1/rooms/'.$group->id.'/calls', ['kind' => 'video'], $this->callerH)->assertOk();
    Queue::assertNotPushed(NotifyIncomingCall::class);
});

test('TC-NOTI-055 a tick sends the ringing web message: tag, renotify, requireInteraction, vibrate, TTL 60, urgent, room link, no badge', function () {
    Queue::fake();
    $call = ringStart($this);
    Queue::fake(); // forget the start dispatch; observe only what the tick queues

    ringTick($call, $this->callee);

    $msgs = ringSent();
    expect($msgs)->toHaveCount(1);
    $m = $msgs[0];
    expect($m['token'])->toBe('web-tok')
        ->and($m['data']['type'])->toBe('call')
        ->and($m['data']['call_id'])->toBe($call->id)
        ->and($m['data']['room_id'])->toBe($this->dm->id)
        ->and($m['data']['kind'])->toBe('video')
        ->and($m['data'])->not->toHaveKey('badge')
        ->and($m['webpush']['notification']['title'])->toBe('Caller Secretname')
        ->and($m['webpush']['notification']['body'])->toBe('สายเรียกเข้า')
        ->and($m['webpush']['notification']['tag'])->toBe('call-'.$call->id)
        ->and($m['webpush']['notification']['requireInteraction'])->toBeTrue()
        ->and($m['webpush']['notification']['renotify'])->toBeTrue()
        ->and($m['webpush']['notification']['vibrate'])->toBeArray()->not->toBeEmpty()
        ->and($m['webpush']['headers'])->toMatchArray(['Topic' => 'call-'.$call->id, 'TTL' => '60', 'Urgency' => 'high'])
        ->and($m['webpush']['fcm_options']['link'])->toBe('https://chat.example/rooms/'.$this->dm->id)
        ->and($m)->not->toHaveKeys(['android', 'apns']);

    Queue::assertPushed(NotifyIncomingCall::class, fn ($j) => $j->tick === 1 && $j->delay !== null);
});

test('TC-NOTI-056 the ring repeats every 10 s and stops after the 60 s window (6 ticks)', function () {
    Queue::fake();
    $call = ringStart($this);
    Queue::fake();

    ringTick($call, $this->callee, 4);
    Queue::assertPushed(NotifyIncomingCall::class, fn ($j) => $j->tick === 5);

    Queue::fake();
    ringTick($call, $this->callee, 5); // the 6th and last ring — nothing is queued after it
    Queue::assertNotPushed(NotifyIncomingCall::class);
    expect(ringSent())->toHaveCount(2);
});

test('TC-NOTI-057 the ring stops without sending when the call ended, connected, was joined by the callee, is past 60 s or the callee lost access', function () {
    Queue::fake();
    $cases = [
        'ended' => fn (RoomCall $c) => $c->update(['ended_at' => now()]),
        'connected' => fn (RoomCall $c) => $c->update(['connected_at' => now()]),
        'joined' => fn (RoomCall $c) => ringJoin($c, $this->callee),
        'window' => fn (RoomCall $c) => RoomCall::whereKey($c->id)->update(['created_at' => now()->subSeconds(61)]),
        'removed' => fn (RoomCall $c) => $this->dm->members()->updateExistingPivot($this->callee->id, ['left_at' => now()]),
    ];

    foreach ($cases as $name => $mutate) {
        RoomCall::query()->delete();
        CallParticipant::query()->delete();
        $this->dm->members()->updateExistingPivot($this->callee->id, ['left_at' => null]);
        $call = ringStart($this);
        Queue::fake();
        $mutate($call);

        ringTick($call->fresh(), $this->callee);

        expect(ringSent())->toHaveCount(0, "case {$name} must not push");
        Queue::assertNotPushed(NotifyIncomingCall::class);
    }
});

test('TC-NOTI-058 a callee with no push token gets no push and the loop is not re-queued', function () {
    Queue::fake();
    $call = ringStart($this);
    Queue::fake();
    Device::query()->delete();
    Device::query()->create(['user_id' => $this->callee->id, 'platform' => 'web', 'push_token' => null, 'push_provider' => null]);

    ringTick($call, $this->callee);

    expect(ringSent())->toHaveCount(0);
    Queue::assertNotPushed(NotifyIncomingCall::class);
});

test('TC-NOTI-059 privacy mode masks the ring: no caller name anywhere in the serialized message; delivery is not suppressed', function () {
    Queue::fake();
    UserNotificationSetting::create(['user_id' => $this->callee->id, 'privacy_mode' => true]);
    $call = ringStart($this);

    ringTick($call, $this->callee);

    $msgs = ringSent();
    expect($msgs)->toHaveCount(1);
    $wire = json_encode($msgs[0]);
    expect($wire)->not->toContain('Secretname')->not->toContain('Caller')
        ->and($msgs[0]['webpush']['notification']['title'])->toBe('Banana Chat')
        ->and($msgs[0]['webpush']['notification']['body'])->toBe('สายเรียกเข้า');
});

test('TC-NOTI-059 the call line follows the RECIPIENT locale', function () {
    Queue::fake();
    $this->callee->update(['locale' => 'en']);
    $call = ringStart($this);

    ringTick($call, $this->callee);

    expect(ringSent()[0]['webpush']['notification']['body'])->toBe('Incoming call');
});

test('TC-NOTI-060 native devices get a high-priority ring that expires in 60 s and does not reset the app badge', function () {
    Queue::fake();
    Device::query()->create(['user_id' => $this->callee->id, 'platform' => 'ios', 'push_token' => 'ios-tok', 'push_provider' => 'fcm']);
    $call = ringStart($this);

    ringTick($call, $this->callee);

    $native = collect(ringSent())->firstWhere('token', 'ios-tok');
    expect($native['android']['priority'])->toBe('high')
        ->and($native['android']['ttl'])->toBe('60s')
        ->and($native['android']['collapse_key'])->toBe('call-'.$call->id)
        ->and((int) $native['apns']['headers']['apns-expiration'])->toBeGreaterThan(time())->toBeLessThanOrEqual(time() + 61)
        ->and($native['apns']['payload']['aps'])->not->toHaveKey('badge')
        ->and($native['notification']['title'])->toBe('Caller Secretname');
});

test('TC-NOTI-061 a retried tick does not ring the same device twice', function () {
    Queue::fake();
    $call = ringStart($this);

    ringTick($call, $this->callee, 2);
    ringTick($call, $this->callee, 2);

    expect(ringSent())->toHaveCount(1);
});

test('TC-NOTI-061 one failing device does not stop the others or throw', function () {
    Queue::fake();
    Device::query()->create(['user_id' => $this->callee->id, 'platform' => 'web', 'push_token' => 'bad-tok', 'push_provider' => 'fcm']);
    Http::fake([
        'oauth2.googleapis.com/*' => Http::response(['access_token' => 'tok', 'expires_in' => 3600]),
        'fcm.googleapis.com/*' => Http::sequence()->push(['error' => ['status' => 'UNAVAILABLE']], 503)->push(['name' => 'ok'], 200),
    ]);
    $call = ringStart($this);

    ringTick($call, $this->callee);

    expect(ringSent())->toHaveCount(2);
});

test('TC-NOTI-062 an unanswered end queues a missed-call that REPLACES the ring (same tag), quiet, and only if the ring was pushed', function () {
    Queue::fake();
    $call = ringStart($this);
    ringTick($call, $this->callee); // marks the ring as pushed
    Queue::fake();

    app(CallService::class)->end($call->fresh()); // caller cancels / 60 s timeout
    Queue::assertPushed(NotifyMissedCall::class, fn ($j) => $j->recipientId === $this->callee->id && $j->delay !== null);

    (new NotifyMissedCall($call->id, $this->callee->id))->handle(app(CallPush::class));

    $m = collect(ringSent())->last();
    expect($m['data']['type'])->toBe('call_missed')
        ->and($m['webpush']['notification']['body'])->toBe('สายที่ไม่ได้รับ')
        ->and($m['webpush']['notification']['tag'])->toBe('call-'.$call->id)
        ->and($m['webpush']['notification']['requireInteraction'])->toBeFalse()
        ->and($m['webpush']['notification']['renotify'])->toBeFalse()
        ->and($m['webpush']['notification'])->not->toHaveKey('vibrate')
        ->and($m['webpush']['headers']['Topic'])->toBe('call-'.$call->id)
        ->and($m['webpush']['headers']['TTL'])->toBe('3600');

    // a second run (retry / duplicate end) sends nothing more
    $before = count(ringSent());
    (new NotifyMissedCall($call->id, $this->callee->id))->handle(app(CallPush::class));
    expect(ringSent())->toHaveCount($before);
});

test('TC-NOTI-063 no missed-call when the callee declined, answered, the call connected, or no ring was ever pushed', function () {
    Queue::fake();

    // declined by the callee → the controller path skips the missed-call entirely
    $call = ringStart($this);
    ringTick($call, $this->callee);
    Queue::fake();
    $this->postJson('/api/v1/calls/'.$call->id.'/decline', [], $this->calleeH)->assertNoContent();
    Queue::assertNotPushed(NotifyMissedCall::class);

    // ring never pushed (e.g. muted / no token at start): the job refuses
    RoomCall::query()->delete();
    Cache::flush();
    $call = ringStart($this);
    $call->update(['ended_at' => now()]);
    $before = count(ringSent());
    (new NotifyMissedCall($call->id, $this->callee->id))->handle(app(CallPush::class));
    expect(ringSent())->toHaveCount($before);

    // callee joined then the call ended before "connected": answered, not missed
    RoomCall::query()->delete();
    CallParticipant::query()->delete();
    Cache::flush();
    $call = ringStart($this);
    ringTick($call, $this->callee);
    ringJoin($call, $this->callee);
    $call->update(['ended_at' => now()]);
    $before = count(ringSent());
    (new NotifyMissedCall($call->id, $this->callee->id))->handle(app(CallPush::class));
    expect(ringSent())->toHaveCount($before);

    // connected call → never "missed"
    RoomCall::query()->delete();
    CallParticipant::query()->delete();
    Cache::flush();
    $call = ringStart($this);
    ringTick($call, $this->callee);
    $call->update(['ended_at' => now(), 'connected_at' => now()]);
    $before = count(ringSent());
    (new NotifyMissedCall($call->id, $this->callee->id))->handle(app(CallPush::class));
    expect(ringSent())->toHaveCount($before);
});

test('TC-NOTI-062 the starter leaving a dm before it connects also queues the missed-call', function () {
    Queue::fake();
    $call = ringStart($this);
    ringTick($call, $this->callee);
    $sessionId = ringJoin($call, $this->caller)->session_id;
    Queue::fake();

    app(CallService::class)->leave($call->fresh(), $this->caller->id, $sessionId);

    Queue::assertPushed(NotifyMissedCall::class, fn ($j) => $j->recipientId === $this->callee->id);
});
