<?php

use Illuminate\Support\Facades\DB;

/**
 * TASK-BE-011 — GET /api/v1/health reports dependency checks (FR-OPS-001).
 */
test('health returns 200 with db, redis, storage, reverb, queue checks', function () {
    $response = $this->getJson('/api/v1/health');

    $response->assertOk()
        ->assertJsonPath('status', 'healthy')
        ->assertJsonPath('checks.database', 'ok')
        ->assertJsonPath('checks.redis', 'ok')
        ->assertJsonPath('checks.storage', 'ok')
        ->assertJsonPath('checks.reverb', 'ok');
});

test('health degrades to unhealthy with failed dependency status when db is down', function () {
    config(['database.connections.pgsql.database' => 'orgchat_missing']);
    DB::purge();

    $response = $this->getJson('/api/v1/health');

    expect($response->status())->toBe(503)
        ->and($response->json('status'))->toBe('degraded')
        ->and($response->json('checks.database'))->not->toBe('ok');

    DB::purge(); // restore for RefreshDatabase teardown
    config(['database.connections.pgsql.database' => 'orgchat_test']);
});
