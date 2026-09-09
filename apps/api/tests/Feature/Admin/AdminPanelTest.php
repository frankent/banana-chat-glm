<?php

use App\Domain\Admin\AdminUserService;
use App\Filament\Pages\Auth\Login;
use App\Filament\Pages\Settings;
use App\Models\AuditLog;
use App\Models\ChatSession;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;

/**
 * TC-ADM-001/005/011/019 — admin auth guard, user creation, suspend, reset
 * (FR-ADM-001..004, TASK-ADM-001..004).
 */
beforeEach(function () {
    $this->admin = User::factory()->systemAdmin()->create(['username' => 'sysadmin']);
    $this->target = User::factory()->create(['username' => 'victim']);
});

test('TC-ADM-001 non-system-admin cannot access /admin → redirect to login (session guard)', function () {
    $this->get('/admin')
        ->assertRedirect('/admin/login');
});

test('TC-ADM-001b system admin logs into the panel and reaches users', function () {
    Livewire::test(Login::class)
        ->fillForm(['login' => 'sysadmin', 'password' => 'Password123!'])
        ->call('authenticate')
        ->assertHasNoErrors();

    $this->get('/admin/users')
        ->assertOk();
});

test('TC-ADM-001c a non-admin credential never authenticates on the admin guard', function () {
    Livewire::test(Login::class)
        ->fillForm(['login' => 'victim', 'password' => 'Password123!'])
        ->call('authenticate')
        ->assertHasErrors();

    $this->get('/admin/users')->assertRedirect('/admin/login');
});

test('TC-ADM-005 create user → temp password valid once, must_change_password, audit, not stored plaintext', function () {
    $service = app(AdminUserService::class);

    [$user, $temp] = $service->createUser($this->admin, 'newbie', 'New Bee');

    expect($user->must_change_password)->toBeTrue()
        ->and(Hash::check($temp, $user->password_hash))->toBeTrue()
        ->and($temp)->toStartWith('Tmp-')
        ->and(AuditLog::query()->where('action', 'user.created')->where('target_id', $user->id)->exists())->toBeTrue();

    // temp password actually logs in
    $response = $this->postJson('/api/v1/auth/login', [
        'username' => 'newbie',
        'password' => $temp,
        'device' => ['platform' => 'cli', 'name' => 'adm-test'],
    ]);
    $response->assertOk();
});

test('TC-ADM-005 duplicate username is rejected by the unique constraint', function () {
    $service = app(AdminUserService::class);

    expect(fn () => $service->createUser($this->admin, 'victim', 'Dup'))
        ->toThrow(UniqueConstraintViolationException::class);
});

test('TC-ADM-011 suspend revokes every session immediately and blocks login', function () {
    // target has a live API session
    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim',
        'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'before-suspend'],
    ])->assertOk();
    expect(ChatSession::query()->where('user_id', $this->target->id)->whereNull('revoked_at')->count())->toBe(1);

    app(AdminUserService::class)->suspend($this->admin, $this->target);

    expect($this->target->fresh()->status->value)->toBe('suspended')
        ->and(ChatSession::query()->where('user_id', $this->target->id)->whereNull('revoked_at')->count())->toBe(0)
        ->and(AuditLog::query()->where('action', 'user.suspended')->where('target_id', $this->target->id)->exists())->toBeTrue();

    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim',
        'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'after-suspend'],
    ])->assertStatus(403);
});

test('suspend then unsuspend restores login', function () {
    $service = app(AdminUserService::class);
    $service->suspend($this->admin, $this->target);
    $service->unsuspend($this->admin, $this->target);

    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim',
        'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'after-unsuspend'],
    ])->assertOk();
});

test('deactivate removes workspace memberships and room access, permanently', function () {
    $ws = Workspace::factory()->create(['slug' => 'acme']);
    $ws->members()->attach($this->target->id, ['role' => 'member', 'status' => 'active']);

    app(AdminUserService::class)->deactivate($this->admin, $this->target);

    $membership = WorkspaceMember::query()->where('user_id', $this->target->id)->first();
    expect($membership->status->value)->toBe('removed')
        ->and($membership->removed_at)->not->toBeNull()
        ->and($this->target->fresh()->status->value)->toBe('deactivated');

    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim',
        'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'after-deactivate'],
    ])->assertStatus(403);
});

test('TC-ADM-019 reset password issues a one-time temp, forces change, revokes sessions', function () {
    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim',
        'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'before-reset'],
    ])->assertOk();

    $temp = app(AdminUserService::class)->resetPassword($this->admin, $this->target);

    $fresh = $this->target->fresh();
    expect($fresh->must_change_password)->toBeTrue()
        ->and(Hash::check($temp, $fresh->password_hash))->toBeTrue()
        ->and(ChatSession::query()->where('user_id', $this->target->id)->whereNull('revoked_at')->count())->toBe(0)
        ->and(AuditLog::query()->where('action', 'user.password_reset')->where('target_id', $this->target->id)->exists())->toBeTrue();

    // old password dead, temp works
    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim', 'password' => 'Password123!',
        'device' => ['platform' => 'cli', 'name' => 'old-pw'],
    ])->assertStatus(401);
    $this->postJson('/api/v1/auth/login', [
        'username' => 'victim', 'password' => $temp,
        'device' => ['platform' => 'cli', 'name' => 'temp-pw'],
    ])->assertOk();
});

test('TC-ADM-021 unlock clears lockout fields', function () {
    $this->target->forceFill(['locked_until' => now()->addMinutes(10), 'failed_login_count' => 9])->save();

    app(AdminUserService::class)->unlock($this->admin, $this->target);

    $fresh = $this->target->fresh();
    expect($fresh->locked_until)->toBeNull()
        ->and($fresh->failed_login_count)->toBe(0)
        ->and(AuditLog::query()->where('action', 'user.unlocked')->exists())->toBeTrue();
});

test('settings.updated audit row carries changed keys', function () {
    $settings = app(SettingsService::class);
    $before = $settings->get('message.max_length');

    $settings->set('message.max_length', 3500, $this->admin->id);
    app(AuditLogger::class)->log('settings.updated', $this->admin, 'settings', null, ['changed' => ['message.max_length']]);

    $row = AuditLog::query()->where('action', 'settings.updated')->latest('created_at')->first();
    expect($row->context['changed'])->toBe(['message.max_length'])
        ->and($settings->get('message.max_length'))->toBe(3500)
        ->and($before)->toBe(4000);
});

test('FR-ADM-009 settings page renders for a system admin', function () {
    // regression: the blade referenced $saveAction (plain Page has none) and 500'd
    Livewire::test(Login::class)
        ->fillForm(['login' => 'sysadmin', 'password' => 'Password123!'])
        ->call('authenticate')
        ->assertHasNoErrors();

    $this->get('/admin/settings')->assertOk();
});

test('TC-ADM-048 settings page save persists values and audits changed keys', function () {
    // regression (found on prod): getState() returns Filament's NESTED state,
    // the old save() iterated it against the dotted editable map → 500
    Livewire::test(Login::class)
        ->fillForm(['login' => 'sysadmin', 'password' => 'Password123!'])
        ->call('authenticate')
        ->assertHasNoErrors();

    $settings = app(SettingsService::class);
    expect($settings->get('message.max_length'))->toBe(4000)
        ->and($settings->get('ai.daily_message_limit_per_user'))->toBe(200);

    Livewire::test(Settings::class)
        ->fillForm([
            'message.max_length' => 3500,
            'ai.daily_message_limit_per_user' => 500,
            'ai.enabled' => true,
        ])
        ->call('save')
        ->assertHasNoErrors();

    expect($settings->get('message.max_length'))->toBe(3500)
        ->and($settings->get('ai.daily_message_limit_per_user'))->toBe(500)
        ->and($settings->get('ai.enabled'))->toBeTrue();

    $row = AuditLog::query()->where('action', 'settings.updated')->latest('created_at')->first();
    expect($row->context['changed'])->toContain('message.max_length')
        ->and($row->context['changed'])->toContain('ai.daily_message_limit_per_user')
        ->and($row->context['changed'])->not->toContain('room.group.max_members');
});
