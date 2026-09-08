<?php

use App\Models\AuditLog;
use App\Models\Room;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;

uses(RefreshDatabase::class);

/*
 * FR-SETUP-001..006 / API-120..123 / TC-SETUP-001..007 — first-run
 * installer. setup.env_path / setup.marker_path point at temp files so the
 * wizard's .env writes never touch the real environment.
 */
beforeEach(function () {
    $this->envPath = tempnam(sys_get_temp_dir(), 'setup-env-');
    $this->markerPath = tempnam(sys_get_temp_dir(), 'setup-marker-');
    File::put($this->envPath, "# existing comment survives\nAPP_NAME=BananaChat\n");
    File::delete($this->markerPath);

    config([
        'setup.env_path' => $this->envPath,
        'setup.marker_path' => $this->markerPath,
    ]);
});

afterEach(function () {
    File::delete([$this->envPath, $this->markerPath]);
});

/**
 * Valid install payload pointing at the phpunit test database + redis.
 */
function setup_payload(array $overrides = []): array
{
    $pgsql = config('database.connections.pgsql');

    return array_replace_recursive([
        'database' => [
            'host' => $pgsql['host'],
            'port' => (int) $pgsql['port'],
            'database' => $pgsql['database'],
            'username' => $pgsql['username'],
            'password' => $pgsql['password'],
        ],
        'redis' => [
            'host' => config('database.redis.cache.host', '127.0.0.1'),
            'port' => (int) config('database.redis.cache.port', 6379),
            'password' => '',
        ],
        'mail' => [
            'host' => '127.0.0.1',
            'port' => 1025,
            'from_address' => 'no-reply@test.local',
        ],
        'admin' => [
            'username' => 'rootadmin',
            'display_name' => 'ผู้ดูแลระบบ',
            'password' => 'Sup3rSecret!',
        ],
        'workspace' => [
            'name' => 'ACME Corp',
            'slug' => 'acme',
        ],
        'room_name' => 'ทั่วไป',
    ], $overrides);
}

it('gates the whole app behind /setup until installed (TC-SETUP-001)', function () {
    $this->get('/')->assertRedirect('/setup');
    $this->get('/admin/login')->assertRedirect('/setup');

    $this->getJson('/api/v1/rooms')
        ->assertStatus(503)
        ->assertJsonPath('error.code', 'SETUP_REQUIRED');

    // the wizard itself and the health probe stay reachable (FR-SETUP-002)
    $this->get('/setup')->assertOk()->assertSee('Banana Chat');
    $this->getJson('/api/v1/health')->assertOk();
});

it('honors SETUP_COMPLETED=false even when APP_KEY is already generated (TC-SETUP-001)', function () {
    File::put($this->envPath, "APP_KEY=base64:alreadygenerated\nAPP_ENV=local\nSETUP_COMPLETED=false\n");

    $this->get('/')->assertRedirect('/setup');
    $this->get('/setup')->assertOk();
});

it('reports status with requirements and defaults (TC-SETUP-002, API-120)', function () {
    $this->getJson('/api/v1/setup/status')
        ->assertOk()
        ->assertJsonPath('data.completed', false)
        ->assertJsonPath('data.requirements.php_version.ok', true)
        ->assertJsonPath('data.requirements.env_writable', true)
        ->assertJsonStructure([
            'data' => [
                'requirements' => ['php_version', 'extensions', 'storage_writable', 'env_writable'],
                'defaults' => ['database', 'redis', 'mail'],
            ],
        ]);
});

it('probes postgres with real PDO — bad creds fail, phpunit creds pass (TC-SETUP-003, API-121)', function () {
    $this->postJson('/api/v1/setup/test-database', [
        'host' => '127.0.0.1',
        'port' => 5433,
        'database' => 'orgchat_test',
        'username' => 'orgchat',
        'password' => 'definitely-wrong',
    ])->assertOk()->assertJsonPath('data.ok', false);

    $this->postJson('/api/v1/setup/test-database', setup_payload()['database'])
        ->assertOk()
        ->assertJsonPath('data.ok', true)
        ->assertJsonStructure(['data' => ['ok', 'server_version']]);
});

it('probes redis over a raw socket (TC-SETUP-004, API-122)', function () {
    $this->postJson('/api/v1/setup/test-redis', [
        'host' => '127.0.0.1',
        'port' => 59999, // nothing listens here
        'password' => '',
    ])->assertOk()->assertJsonPath('data.ok', false);

    $this->postJson('/api/v1/setup/test-redis', setup_payload()['redis'])
        ->assertOk()
        ->assertJsonPath('data.ok', true);
});

it('installs: writes .env, migrates, creates admin/workspace/room and locks itself (TC-SETUP-005, API-123)', function () {
    $response = $this->postJson('/api/v1/setup/install', setup_payload());

    $response->assertStatus(201)
        ->assertJsonPath('data.ok', true)
        ->assertJsonPath('data.admin_username', 'rootadmin')
        ->assertJsonPath('data.workspace_slug', 'acme')
        ->assertJsonPath('data.redirect', '/admin/login');

    // .env merged: new keys written, existing lines preserved (FR-SETUP-004)
    $env = File::get($this->envPath);
    expect($env)->toContain('# existing comment survives')
        ->toContain('APP_NAME=BananaChat')
        ->toContain('DB_HOST=127.0.0.1')
        ->toContain('DB_PORT=5433')
        ->toContain('DB_DATABASE=orgchat_test')
        ->toContain('REDIS_PORT=6380')
        ->toContain('SETUP_COMPLETED=true')
        ->toMatch('/APP_KEY=base64:[A-Za-z0-9+\/=]{44,}/')
        ->toMatch('/REVERB_APP_KEY=[a-f0-9]{32}/');

    // completion marker dropped (FR-SETUP-006)
    expect($this->markerPath)->toBeFile();

    // first entities, mirroring the seeder
    $admin = User::query()->where('username', 'rootadmin')->firstOrFail();
    expect($admin->is_system_admin)->toBeTrue()
        ->and($admin->status->value)->toBe('active');

    $workspace = Workspace::query()->where('slug', 'acme')->firstOrFail();
    expect($workspace->members()->wherePivot('user_id', $admin->id)
        ->wherePivot('role', 'owner')->exists())->toBeTrue();

    $room = Room::query()->where('workspace_id', $workspace->id)->where('name', 'ทั่วไป')->firstOrFail();
    expect($room->owner_id)->toBe($admin->id)
        ->and($room->members()->wherePivot('user_id', $admin->id)->exists())->toBeTrue();

    expect(AuditLog::query()->where('action', 'setup.completed')->count())->toBe(1);

    // gate lifted…
    $this->get('/')->assertOk();
    // …and the wizard hard-locks (FR-SETUP-006)
    $this->get('/setup')->assertRedirect('/');
    $this->postJson('/api/v1/setup/install', setup_payload())
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'SETUP_ALREADY_COMPLETED');
    $this->postJson('/api/v1/setup/test-database', setup_payload()['database'])
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'SETUP_ALREADY_COMPLETED');
});

it('refuses to install when a probe fails and leaves .env untouched (TC-SETUP-006)', function () {
    $this->postJson('/api/v1/setup/install', setup_payload([
        'database' => ['password' => 'wrong-password'],
    ]))->assertStatus(422)->assertJsonPath('error.code', 'SETUP_DB_UNREACHABLE');

    expect(File::get($this->envPath))->not->toContain('DB_HOST')
        ->and($this->markerPath)->not->toBeFile();
});

it('validates install input with the standard 422 envelope (TC-SETUP-007)', function () {
    $this->postJson('/api/v1/setup/install', [
        'database' => ['host' => '127.0.0.1'],
    ])->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');

    // bad workspace slug must fail the regex rule
    $this->postJson('/api/v1/setup/install', setup_payload([
        'workspace' => ['slug' => 'Not A Slug'],
    ]))->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
});
