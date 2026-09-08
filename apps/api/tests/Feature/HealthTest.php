<?php

use Illuminate\Support\Facades\DB;

/**
 * TASK-BE-011 — GET /api/v1/health reports dependency checks (FR-OPS-001).
 */
test('health returns 200 with db, redis, storage, reverb, queue checks', function () {
    $response = $this->getJson('/api/v1/health');

    if ($response->status() !== 200) {
        // surface which dependency degraded — the assertion alone says only "503"
        fwrite(STDERR, 'HEALTH DEBUG disk='.config('filesystems.default')
            .' env_FILESYSTEM_DISK='.(getenv('FILESYSTEM_DISK') ?: '(unset)')
            .' redis='.config('database.redis.cache.host').':'.config('database.redis.cache.port')
            .' reverb='.config('reverb.servers.reverb.hostname').':'.config('reverb.servers.reverb.port')
            .' queue='.config('queue.default')
            .' BODY='.$response->getContent()."\n");
    }

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
