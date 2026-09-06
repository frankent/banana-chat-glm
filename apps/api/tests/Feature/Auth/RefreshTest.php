<?php

use App\Models\AccessToken;
use App\Models\AuditLog;
use App\Models\ChatSession;
use App\Models\User;

/**
 * TC-AUTH-009..012 — refresh rotation & reuse detection (FR-AUTH-002).
 */
test('TC-AUTH-009 refresh rotates both tokens, rolls expires_at', function () {
    $user = User::factory()->create();
    [$user, $accessToken, $refreshToken] = loginAs($user);

    $oldSession = ChatSession::where('user_id', $user->id)->first();

    $response = $this->postJson('/api/v1/auth/refresh', [
        'refresh_token' => $refreshToken,
    ]);

    $response->assertOk()->assertJsonStructure(['access_token', 'expires_in', 'refresh_token']);

    $session = $oldSession->fresh();
    expect($session->prev_refresh_token_hash)->not->toBeNull()
        ->and($session->prev_refresh_token_hash)->toBe(hash('sha256', $refreshToken))
        ->and($session->expires_at->isFuture())->toBeTrue()
        ->and($response->json('refresh_token'))->not->toBe($refreshToken);
});

test('TC-AUTH-010 reusing a rotated refresh token revokes the whole session + audits', function () {
    $user = User::factory()->create();
    [$user, $accessToken, $refreshToken] = loginAs($user);

    // First refresh succeeds — old token is now spent
    $this->postJson('/api/v1/auth/refresh', ['refresh_token' => $refreshToken])->assertOk();

    // Replay the spent token → theft detection
    $this->postJson('/api/v1/auth/refresh', ['refresh_token' => $refreshToken])
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_REFRESH_REUSED');

    $session = ChatSession::where('user_id', $user->id)->first();
    expect($session->revoked_at)->not->toBeNull()
        ->and(AuditLog::where('action', 'auth.refresh_reuse_detected')->count())->toBe(1);

    // The rotated (newer) token died with the session too
    $this->postJson('/api/v1/auth/refresh', ['refresh_token' => $session->refresh_token_hash])
        ->assertStatus(401);
});

test('TC-AUTH-011 expired refresh token → 401 AUTH_REFRESH_EXPIRED', function () {
    $user = User::factory()->create();
    [$user, $accessToken, $refreshToken] = loginAs($user);

    ChatSession::where('user_id', $user->id)->update(['expires_at' => now()->subMinute()]);

    $this->postJson('/api/v1/auth/refresh', ['refresh_token' => $refreshToken])
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_REFRESH_EXPIRED');
});

test('TC-AUTH-012 expired access token → 401 AUTH_TOKEN_EXPIRED', function () {
    $user = User::factory()->create();
    [$user, $accessToken] = loginAs($user);

    AccessToken::query()->update(['expires_at' => now()->subMinute()]);

    $this->getJson('/api/v1/me', authHeaders($accessToken))
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_TOKEN_EXPIRED');
});
