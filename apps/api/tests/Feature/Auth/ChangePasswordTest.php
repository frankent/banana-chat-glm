<?php

use App\Models\AuditLog;
use App\Models\ChatSession;
use App\Models\User;

/**
 * TC-AUTH-017..019 — change password (FR-AUTH-004).
 */
test('TC-AUTH-017 change password → 204, other sessions revoked, must_change_password cleared', function () {
    $user = User::factory()->mustChangePassword()->create();

    [$user, $tokenA] = loginAs($user, ['name' => 'MacBook']);
    [$user, $tokenB] = loginAs($user, ['name' => 'iPhone']);

    $this->postJson('/api/v1/auth/change-password', [
        'current_password' => 'Password123!',
        'new_password' => 'NewSecure456',
    ], authHeaders($tokenA))->assertNoContent();

    $user = $user->fresh();
    expect($user->must_change_password)->toBeFalse()
        ->and($user->password_changed_at)->not->toBeNull()
        ->and(ChatSession::where('user_id', $user->id)->whereNull('revoked_at')->count())->toBe(1)
        ->and(ChatSession::where('revoked_reason', 'password_change')->count())->toBe(1)
        ->and(AuditLog::where('action', 'auth.password_changed')->count())->toBe(1);

    // Old password no longer works
    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
    ])->assertStatus(401);

    // New password works
    $this->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'NewSecure456',
    ])->assertOk();
});

test('TC-AUTH-018 wrong current password → 422 AUTH_CURRENT_PASSWORD_WRONG', function () {
    $user = User::factory()->create();
    [$user, $token] = loginAs($user);

    $this->postJson('/api/v1/auth/change-password', [
        'current_password' => 'Nope12345',
        'new_password' => 'NewSecure456',
    ], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AUTH_CURRENT_PASSWORD_WRONG');
});

test('TC-AUTH-019 new password identical to current → 422 AUTH_PASSWORD_REUSED', function () {
    $user = User::factory()->create();
    [$user, $token] = loginAs($user);

    $this->postJson('/api/v1/auth/change-password', [
        'current_password' => 'Password123!',
        'new_password' => 'Password123!',
    ], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AUTH_PASSWORD_REUSED');
});

test('TC-AUTH-019a weak new password → 422 AUTH_PASSWORD_WEAK', function () {
    $user = User::factory()->create();
    [$user, $token] = loginAs($user);

    $this->postJson('/api/v1/auth/change-password', [
        'current_password' => 'Password123!',
        'new_password' => 'short1',
    ], authHeaders($token))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'AUTH_PASSWORD_WEAK');
});
