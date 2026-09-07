<?php

use App\Services\SettingsService;
use Illuminate\Support\Facades\Http;

/**
 * TASK-BE-025 — X-App-Version gate (§7 versioning policy).
 */
beforeEach(function () {
    Http::preventStrayRequests();
    app(SettingsService::class)->set('app.min_supported_version', '1.2.0');
});

test('BE-025 version below min → 426 APP_UPDATE_REQUIRED envelope', function () {
    $this->postJson('/api/v1/auth/login', ['username' => 'x', 'password' => 'y'], ['X-App-Version' => '1.1.9'])
        ->assertStatus(426)
        ->assertJsonPath('error.code', 'APP_UPDATE_REQUIRED')
        ->assertJsonPath('error.details.min_supported_version', '1.2.0');
});

test('BE-025 version at or above min passes; numeric segments compare semantically', function () {
    $this->postJson('/api/v1/auth/login', ['username' => 'x', 'password' => 'y'], ['X-App-Version' => '1.2.0'])
        ->assertStatus(401); // gate passed; auth failed on its own terms

    // 1.10 > 1.2 (numeric, not lexicographic)
    $this->postJson('/api/v1/auth/login', ['username' => 'x', 'password' => 'y'], ['X-App-Version' => '1.10'])
        ->assertStatus(401);
});

test('BE-025 no header (web) or empty min → no gate', function () {
    $this->postJson('/api/v1/auth/login', ['username' => 'x', 'password' => 'y'])
        ->assertStatus(401);

    app(SettingsService::class)->set('app.min_supported_version', '');
    $this->postJson('/api/v1/auth/login', ['username' => 'x', 'password' => 'y'], ['X-App-Version' => '0.0.1'])
        ->assertStatus(401);
});
