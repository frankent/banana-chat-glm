<?php

use App\Models\ChatSession;
use App\Models\Device;
use App\Models\User;

/**
 * TC-AUTH-013..016 — logout & session management (FR-AUTH-003).
 */
test('TC-AUTH-013 logout → 204, token dead, device push token dropped', function () {
    $user = User::factory()->create();
    [$user, $accessToken] = loginAs($user);

    $device = Device::where('user_id', $user->id)->first();
    $device->forceFill(['push_token' => 'tok-123'])->save();

    $this->postJson('/api/v1/auth/logout', [], authHeaders($accessToken))->assertNoContent();

    // Token unusable immediately
    $this->getJson('/api/v1/me', authHeaders($accessToken))->assertStatus(401);

    expect($device->fresh()->push_token)->toBeNull()
        ->and(ChatSession::where('user_id', $user->id)->whereNull('revoked_at')->count())->toBe(0);
});

test('TC-AUTH-014 logout-all revokes every session', function () {
    $user = User::factory()->create();

    $tokens = [];
    for ($i = 0; $i < 3; $i++) {
        [$user, $tokens[$i]] = loginAs($user, ['platform' => 'web', 'name' => "Dev-{$i}"]);
    }

    $this->postJson('/api/v1/auth/logout-all', [], authHeaders($tokens[2]))->assertNoContent();

    expect(ChatSession::where('user_id', $user->id)->whereNull('revoked_at')->count())->toBe(0);

    foreach ($tokens as $t) {
        $this->getJson('/api/v1/me', authHeaders($t))->assertStatus(401);
    }
});

test('TC-AUTH-015 GET /me/sessions lists all sessions with is_current', function () {
    $user = User::factory()->create();

    [$user, $tokenA] = loginAs($user, ['name' => 'MacBook']);
    [$user, $tokenB] = loginAs($user, ['name' => 'iPhone']);

    $response = $this->getJson('/api/v1/me/sessions', authHeaders($tokenB));

    $response->assertOk();

    $sessions = collect($response->json('data'));
    expect($sessions)->toHaveCount(2)
        ->and($sessions->where('is_current', true)->count())->toBe(1
        );
});

test('TC-AUTH-016 DELETE /me/sessions/{id} revokes the other session', function () {
    $user = User::factory()->create();

    [$user, $tokenA] = loginAs($user, ['name' => 'MacBook']);
    [$user, $tokenB] = loginAs($user, ['name' => 'iPhone']);

    $target = ChatSession::where('user_id', $user->id)
        ->whereDoesntHave('accessTokens', fn ($q) => $q->where('token_hash', hash('sha256', $tokenB)))
        ->first();

    $this->deleteJson("/api/v1/me/sessions/{$target->id}", headers: authHeaders($tokenB))
        ->assertNoContent();

    // Session A's token is dead, session B's still works
    $this->getJson('/api/v1/me', authHeaders($tokenA))->assertStatus(401);
    $this->getJson('/api/v1/me', authHeaders($tokenB))->assertOk();
});
