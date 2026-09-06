<?php

use App\Domain\Auth\PasswordPolicy;
use App\Exceptions\ApiException;

/**
 * TC-AUTH-020..024 — PasswordPolicy unit.
 */
test('TC-AUTH-020 accepts a strong password', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('CorrectHorse9', 'tony');

    expect(true)->toBeTrue();
});

test('TC-AUTH-020a rejects shorter than min length', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('Ab1', 'tony');
})->throws(ApiException::class);

test('TC-AUTH-020b rejects longer than 128 chars', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid(str_repeat('a1', 129), 'tony');
})->throws(ApiException::class);

test('TC-AUTH-021 rejects letters-only password', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('onlylettershere', 'tony');
})->throws(ApiException::class);

test('TC-AUTH-021a rejects digits-only password', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('1234567890', 'tony');
})->throws(ApiException::class);

test('TC-AUTH-022 rejects password equal to username', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('tony123tony', 'tony123tony');
})->throws(ApiException::class);

test('TC-AUTH-023 rejects common password', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('password123', 'tony');
})->throws(ApiException::class);

test('TC-AUTH-024 accepts unicode password with digits', function () {
    $policy = app(PasswordPolicy::class);

    $policy->assertValid('ทดสอบรหัสผ่าน123', 'tony');

    expect(true)->toBeTrue();
});
