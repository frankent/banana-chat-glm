<?php

use App\Models\User;
use App\Models\Workspace;

/**
 * TC-AUTH-029..032 — middleware chain & workspace header (FR-AUTH-007).
 * Workspace-scoped endpoints arrive in later phases; /me/workspaces is used
 * here only for auth-chain behaviour that already exists.
 */
test('TC-AUTH-029 no bearer token → 401 envelope', function () {
    $this->getJson('/api/v1/me')
        ->assertStatus(401)
        ->assertJsonPath('error.code', 'AUTH_TOKEN_INVALID')
        ->assertJsonStructure(['error' => ['code', 'message', 'request_id']]);
});

test('TC-AUTH-030 garbage bearer token → 401', function () {
    $this->getJson('/api/v1/me', authHeaders('not-a-real-token'))
        ->assertStatus(401);
});

test('TC-AUTH-031 suspended user with valid token → 403 on next request', function () {
    $user = User::factory()->create();
    [$user, $token] = loginAs($user);

    $user->fresh()->forceFill(['status' => 'suspended'])->save();

    $this->getJson('/api/v1/me', authHeaders($token))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'AUTH_ACCOUNT_DISABLED');
});

test('TC-AUTH-032 every response carries X-Request-Id', function () {
    $response = $this->getJson('/api/v1/me');

    expect($response->headers->get('X-Request-Id'))->not->toBeEmpty();
});

test('TC-AUTH-032a echoed X-Request-Id is preserved', function () {
    $response = $this->getJson('/api/v1/me', ['X-Request-Id' => 'my-trace-42']);

    expect($response->headers->get('X-Request-Id'))->toBe('my-trace-42');
});

test('workspace routes without X-Workspace-Id → 400 WS_HEADER_REQUIRED', function () {
    $user = User::factory()->create();
    [$user, $token] = loginAs($user);

    $this->getJson('/api/v1/members', authHeaders($token))
        ->assertStatus(404); // route not built yet — placeholder until Phase 4
})->skip('members route lands in Phase 4', true);
