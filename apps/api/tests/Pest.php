<?php

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| The closure you provide to your test functions is always bound to a specific PHPUnit test
| case class. By default, that class is "PHPUnit\Framework\TestCase". Of course, you may
| need to change it using the "pest()" function to bind different classes or traits.
|
*/

pest()->extend(TestCase::class)
    ->use(RefreshDatabase::class)
    ->in('Feature');

pest()->extend(TestCase::class)
    ->use(RefreshDatabase::class)
    ->in('Unit');

/*
|--------------------------------------------------------------------------
| Expectations
|--------------------------------------------------------------------------
|
| When you're writing tests, you often need to check that values meet certain conditions. The
| "expect()" function gives you access to a set of "expectations" methods that you can use
| to assert different things. Of course, you may extend the Expectation API at any time.
|
*/

expect()->extend('toBeOne', function () {
    return $this->toBe(1);
});

/*
|--------------------------------------------------------------------------
| Functions
|--------------------------------------------------------------------------
|
| While Pest is very powerful out-of-the-box, you may have some testing code specific to your
| project that you don't want to repeat in every file. Here you can also expose helpers as
| global functions to help you to reduce the number of lines of code in your test files.
|
*/

function something()
{
    // ..
}

/**
 * Login a user over HTTP and return [user, access_token, refresh_token].
 * Spec §12 style: exercise real endpoints, not guard shortcuts.
 */
function loginAs(User $user, array $device = ['platform' => 'web', 'name' => 'Test Runner']): array
{
    $response = test()->postJson('/api/v1/auth/login', [
        'username' => $user->username,
        'password' => 'Password123!',
        'device' => $device,
    ]);

    if ($response->status() !== 200) {
        test()->fail("loginAs failed for {$user->username}: ".$response->status().' '.$response->getContent());
    }

    return [$user, $response->json('access_token'), $response->json('refresh_token')];
}

function authHeaders(string $token, array $extra = []): array
{
    return ['Authorization' => "Bearer {$token}"] + $extra;
}

/**
 * Bearer + workspace context headers (FR-WS-003) for workspace-scoped routes.
 */
function wsHeaders(string $token, string $slug, array $extra = []): array
{
    return authHeaders($token, ['X-Workspace-Id' => $slug] + $extra);
}
