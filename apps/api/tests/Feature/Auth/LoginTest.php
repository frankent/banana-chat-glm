<?php

use App\Models\ChatSession;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/**
 * TC-AUTH-001..008 — login (FR-AUTH-001).
 */
test('TC-AUTH-001 login succeeds and returns tokens + user + workspaces', function () {
    $user = User::factory()->create(['username' => 'tony']);
    $ws = Workspace::factory()->create();
    $ws->members()->attach($user->id, ['role' => 'owner']);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => 'tony',
        'password' => 'Password123!',
        'device' => ['platform' => 'web', 'name' => 'MacBook'],
    ]);

    $response->assertOk()
        ->assertJsonStructure(['access_token', 'expires_in', 'refresh_token', 'user', 'workspaces', 'must_change_password']);

    expect($response->json('workspaces.0.workspace.slug'))->toBe($ws->slug)
        ->and($response->json('user.username'))->toBe('tony')
        ->and($response->json('must_change_password'))->toBeFalse();
});

test('TC-AUTH-002 username is case-insensitive', function () {
    User::factory()->create(['username' => 'tony']);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => 'Tony',
        'password' => 'Password123!',
    ]);

    $response->assertOk();
});

test('TC-AUTH-002a username whitespace is trimmed', function () {
    User::factory()->create(['username' => 'tony']);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => '  tony  ',
        'password' => 'Password123!',
    ]);

    $response->assertOk();
});

test('TC-AUTH-003 wrong password → 401 AUTH_INVALID_CREDENTIALS, failed_login_count +1', function () {
    $user = User::factory()->create();

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'WrongPassword1',
    ]);

    $response->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_INVALID_CREDENTIALS');

    expect($user->fresh()->failed_login_count)->toBe(1);
});

test('TC-AUTH-004 unknown username → same 401 code (anti-enumeration)', function () {
    $response = $this->postJson('/api/v1/auth/login', [
        'username' => 'ghost_user',
        'password' => 'Whatever123',
    ]);

    $response->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_INVALID_CREDENTIALS');
});

test('TC-AUTH-005 suspended account → 403 AUTH_ACCOUNT_DISABLED', function () {
    $user = User::factory()->suspended()->create();

    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
    ])->assertStatus(403)->assertJsonPath('error.code', 'AUTH_ACCOUNT_DISABLED');
});

test('TC-AUTH-005a deactivated account → same 403 code', function () {
    $user = User::factory()->deactivated()->create();

    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
    ])->assertStatus(403)->assertJsonPath('error.code', 'AUTH_ACCOUNT_DISABLED');
});

test('TC-AUTH-006 must_change_password token reaches /me but not workspace routes', function () {
    $user = User::factory()->mustChangePassword()->create();

    [$_, $token] = loginAs($user);

    $this->getJson('/api/v1/me', authHeaders($token))->assertOk();

    // Any non-exempt route with the stale password — /me/sessions is enforced
    $this->getJson('/api/v1/me/sessions', authHeaders($token))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'AUTH_PASSWORD_CHANGE_REQUIRED');
});

test('TC-AUTH-007 login without any workspace → 200 with empty workspaces', function () {
    $user = User::factory()->create();

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
    ]);

    $response->assertOk()->assertJsonPath('workspaces', []);
});

test('TC-AUTH-008 exceeding max_sessions revokes oldest sessions', function () {
    $user = User::factory()->create();

    for ($i = 0; $i < 11; $i++) { // default max = 10
        $this->postJson('/api/v1/auth/login', [
            'username' => $user->username,
            'password' => 'Password123!',
            'device' => ['platform' => 'web', 'name' => "Device-{$i}"],
        ])->assertOk();
    }

    expect(ChatSession::where('user_id', $user->id)->whereNull('revoked_at')->count())->toBe(10);

    $evicted = ChatSession::where('user_id', $user->id)->whereNotNull('revoked_at')->get();
    expect($evicted)->not->toBeEmpty()
        ->and($evicted->every(fn ($s) => $s->revoked_reason === 'rotation'))->toBeTrue();
});

test('TC-AUTH-001a successful login creates session + device rows and resets counter', function () {
    $user = User::factory()->create(['failed_login_count' => 5]);

    $response = $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
        'device' => ['platform' => 'web', 'name' => 'iPhone'],
    ]);

    $response->assertOk();

    expect($user->fresh()->failed_login_count)->toBe(0)
        ->and(ChatSession::where('user_id', $user->id)->count())->toBe(1)
        ->and(DB::table('devices')->where('user_id', $user->id)->count())->toBe(1)
        ->and(DB::table('audit_logs')->where('action', 'auth.login')->count())->toBe(1);
});
