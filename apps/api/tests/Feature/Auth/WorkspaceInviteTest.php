<?php

use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceInvite;
use App\Models\WorkspaceMember;

/**
 * TC-WS-022..024 (issue/revoke, FR-WS-006) + TC-AUTH-033..038 (redeem, FR-AUTH-008).
 * DEC-081 — owner/admin-issued, single-use, 24h invite → new account → join as member.
 */
beforeEach(function () {
    $this->owner = User::factory()->create(['username' => 'tony']);
    $this->admin = User::factory()->create(['username' => 'anna']);
    $this->member = User::factory()->create(['username' => 'somchai']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme', 'name' => 'Acme Corp']);
    $this->ws->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->admin->id, ['role' => 'admin']);
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);
});

test('TC-WS-022 owner issues an invite and gets a 64-hex token + join_url', function () {
    [, $token] = loginAs($this->owner);

    $response = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $response->assertCreated()
        ->assertJsonStructure(['data' => ['id', 'token', 'join_url', 'expires_at']]);

    expect($response->json('data.token'))->toMatch('/^[a-f0-9]{64}$/')
        ->and($response->json('data.join_url'))->toContain('/join/'.$response->json('data.token'));

    $invite = WorkspaceInvite::findOrFail($response->json('data.id'));
    expect($invite->workspace_id)->toBe($this->ws->id)
        ->and($invite->created_by)->toBe($this->owner->id)
        ->and($invite->token_hash)->toBe(hash('sha256', $response->json('data.token')))
        ->and($invite->expires_at->diffInHours(now(), true))->toBeLessThan(25);
});

test('TC-WS-022a admin (not just owner) can also issue an invite', function () {
    [, $token] = loginAs($this->admin);

    $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'))->assertCreated();
});

test('TC-WS-022b plain member cannot issue an invite → 403 WS_FORBIDDEN', function () {
    [, $token] = loginAs($this->member);

    $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'))
        ->assertStatus(403)
        ->assertJsonPath('error.code', 'WS_FORBIDDEN');
});

test('TC-WS-023 owner revokes an unused invite; a later redeem fails', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->deleteJson('/api/v1/workspace-invites/'.$issue->json('data.id'), [], wsHeaders($token, 'acme'))
        ->assertNoContent();

    expect(WorkspaceInvite::findOrFail($issue->json('data.id'))->revoked_at)->not->toBeNull();

    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'revoked_test', 'password' => 'Sup3rSecretPW', 'display_name' => 'Revoked Test',
    ])->assertStatus(410)->assertJsonPath('error.code', 'INVITE_REVOKED');
});

test('TC-WS-023a plain member cannot revoke another admin\'s invite', function () {
    [, $ownerToken] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($ownerToken, 'acme'));

    [, $memberToken] = loginAs($this->member);
    $this->deleteJson('/api/v1/workspace-invites/'.$issue->json('data.id'), [], wsHeaders($memberToken, 'acme'))
        ->assertStatus(403);
});

test('TC-WS-024 revoking an invite from another workspace 404s (no cross-workspace leak)', function () {
    $other = Workspace::factory()->create(['slug' => 'globex']);
    $other->members()->attach($this->owner->id, ['role' => 'owner']);

    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->deleteJson('/api/v1/workspace-invites/'.$issue->json('data.id'), [], wsHeaders($token, 'globex'))
        ->assertStatus(404)
        ->assertJsonPath('error.code', 'INVITE_NOT_FOUND');
});

test('TC-AUTH-033 preview (GET /join/{token}) is public and returns the workspace name only', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->getJson('/api/v1/join/'.$issue->json('data.token'))
        ->assertOk()
        ->assertExactJson(['data' => ['workspace' => ['name' => 'Acme Corp']]]);
});

test('TC-AUTH-033a preview does not consume the invite — callable repeatedly', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->getJson('/api/v1/join/'.$issue->json('data.token'))->assertOk();
    $this->getJson('/api/v1/join/'.$issue->json('data.token'))->assertOk();

    expect(WorkspaceInvite::findOrFail($issue->json('data.id'))->used_at)->toBeNull();
});

test('TC-AUTH-034 unknown token → 404 INVITE_NOT_FOUND', function () {
    $this->getJson('/api/v1/join/'.str_repeat('a', 64))
        ->assertStatus(404)
        ->assertJsonPath('error.code', 'INVITE_NOT_FOUND');
});

test('TC-AUTH-034a malformed token never reaches the controller → plain 404', function () {
    $this->getJson('/api/v1/join/not-64-hex-chars')
        ->assertStatus(404)
        ->assertJsonPath('error.code', 'NOT_FOUND');
});

test('TC-AUTH-034b expired token → 410 INVITE_EXPIRED', function () {
    $invite = WorkspaceInvite::create([
        'workspace_id' => $this->ws->id,
        'created_by' => $this->owner->id,
        'token_hash' => hash('sha256', $plain = str_repeat('b', 64)),
        'expires_at' => now()->subMinute(),
    ]);

    $this->getJson('/api/v1/join/'.$plain)
        ->assertStatus(410)
        ->assertJsonPath('error.code', 'INVITE_EXPIRED');
});

test('TC-AUTH-035 redeeming creates a new account, joins the workspace as member, and logs in', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $response = $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'newperson',
        'password' => 'Sup3rSecretPW',
        'display_name' => 'New Person',
        'device' => ['platform' => 'web', 'name' => 'Test Runner'],
    ]);

    $response->assertCreated()
        ->assertJsonStructure(['access_token', 'expires_in', 'refresh_token', 'user', 'workspaces', 'must_change_password'])
        ->assertJsonPath('user.username', 'newperson')
        ->assertJsonPath('must_change_password', false);

    $user = User::where('username', 'newperson')->firstOrFail();
    expect($user->created_by)->toBe($this->owner->id);

    $membership = WorkspaceMember::where('workspace_id', $this->ws->id)->where('user_id', $user->id)->firstOrFail();
    expect($membership->role->value)->toBe('member')
        ->and($membership->invited_by)->toBe($this->owner->id);

    // The returned access token is real and usable immediately.
    $this->getJson('/api/v1/me', authHeaders($response->json('access_token')))
        ->assertOk()->assertJsonPath('data.user.username', 'newperson');

    expect(WorkspaceInvite::findOrFail($issue->json('data.id'))->used_at)->not->toBeNull();
});

test('TC-AUTH-035a the created account uses the locale the join page was submitted in, not a hardcoded default', function () {
    [, $token] = loginAs($this->owner);

    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'englishspeaker', 'password' => 'Sup3rSecretPW', 'display_name' => 'English Speaker', 'locale' => 'en',
    ])->assertCreated();
    expect(User::where('username', 'englishspeaker')->firstOrFail()->locale)->toBe('en');

    $issue2 = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $this->postJson('/api/v1/join/'.$issue2->json('data.token'), [
        'username' => 'no-locale-sent', 'password' => 'Sup3rSecretPW', 'display_name' => 'No Locale Sent',
    ])->assertCreated();
    expect(User::where('username', 'no-locale-sent')->firstOrFail()->locale)->toBe('th');
});

test('TC-AUTH-036 redeeming an already-used token → 409 INVITE_ALREADY_USED, no second account', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'firstperson', 'password' => 'Sup3rSecretPW', 'display_name' => 'First',
    ])->assertCreated();

    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'secondperson', 'password' => 'Sup3rSecretPW', 'display_name' => 'Second',
    ])->assertStatus(409)->assertJsonPath('error.code', 'INVITE_ALREADY_USED');

    expect(User::where('username', 'secondperson')->exists())->toBeFalse();
});

test('TC-AUTH-037 weak password → 422 AUTH_PASSWORD_WEAK, username taken → 422 AUTH_USERNAME_TAKEN', function () {
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));

    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'weakpw', 'password' => '123', 'display_name' => 'Weak',
    ])->assertStatus(422)->assertJsonPath('error.code', 'AUTH_PASSWORD_WEAK');

    $issue2 = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $this->postJson('/api/v1/join/'.$issue2->json('data.token'), [
        'username' => 'tony', 'password' => 'Sup3rSecretPW', 'display_name' => 'Impersonator',
    ])->assertStatus(422)->assertJsonPath('error.code', 'AUTH_USERNAME_TAKEN');
});

test('TC-AUTH-037a username must match PRODUCT_SPEC.md:300 (3-32, lowercase [a-z0-9._-])', function () {
    [, $token] = loginAs($this->owner);

    foreach (['UpperCase', 'has space', 'ab', str_repeat('a', 33), 'bad!char', ''] as $badUsername) {
        $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
        $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
            'username' => $badUsername, 'password' => 'Sup3rSecretPW', 'display_name' => 'Format Test',
        ])->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
    }

    // The exact boundary values (3 and 32 chars) must be ACCEPTED, not rejected.
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => 'ab3', 'password' => 'Sup3rSecretPW', 'display_name' => 'Boundary Min',
    ])->assertCreated();

    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $this->postJson('/api/v1/join/'.$issue->json('data.token'), [
        'username' => str_repeat('a', 32), 'password' => 'Sup3rSecretPW', 'display_name' => 'Boundary Max',
    ])->assertCreated();
});

test('TC-AUTH-038 repeated redemption attempts after the first only ever succeed once', function () {
    // Pest's test client runs requests sequentially in-process, so this proves
    // "N attempts, exactly 1 success" rather than genuine wall-clock
    // concurrency; the actual race-safety guarantee is the lockForUpdate()
    // claim inside a transaction in RedeemInviteAction, the same pattern
    // PublicChatService::close() already uses in this codebase.
    [, $token] = loginAs($this->owner);
    $issue = $this->postJson('/api/v1/workspace-invites', [], wsHeaders($token, 'acme'));
    $plainToken = $issue->json('data.token');

    $results = collect(range(1, 5))->map(fn ($i) => $this->postJson('/api/v1/join/'.$plainToken, [
        'username' => "racer{$i}", 'password' => 'Sup3rSecretPW', 'display_name' => "Racer {$i}",
    ])->status());

    expect($results->filter(fn ($s) => $s === 201))->toHaveCount(1)
        ->and($results->filter(fn ($s) => $s === 409))->toHaveCount(4);

    expect(WorkspaceMember::where('workspace_id', $this->ws->id)->where('role', 'member')->count())->toBe(2); // somchai (seeded) + the one winner
});
