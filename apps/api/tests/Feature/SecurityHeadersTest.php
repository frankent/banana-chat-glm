<?php

use Illuminate\Support\Facades\Http;

/**
 * TASK-QA-007 / NFR-SEC-008 — security headers on API responses.
 */
test('NFR-SEC-008 API responses carry baseline security headers', function () {
    Http::preventStrayRequests();

    $this->postJson('/api/v1/auth/login', [])
        ->assertStatus(422) // validation, not a header-dependent path
        ->assertHeader('X-Content-Type-Options', 'nosniff')
        ->assertHeader('X-Frame-Options', 'DENY')
        ->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
        ->assertHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

test('NFR-SEC-008 admin panel responses are frame-denied', function () {
    Http::preventStrayRequests();

    $this->get('/admin/login')
        ->assertHeader('X-Frame-Options', 'DENY')
        ->assertHeader('X-Content-Type-Options', 'nosniff');
});
