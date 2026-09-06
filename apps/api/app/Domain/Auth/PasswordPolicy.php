<?php

namespace App\Domain\Auth;

use App\Exceptions\ApiException;
use App\Services\SettingsService;

/**
 * FR-AUTH-005 password policy: ≥ min length, letters+digits, ≠ username,
 * not common, ≤ 128 chars, unicode-safe.
 */
class PasswordPolicy
{
    /**
     * Bundled top-common list (~100 entries; spec allows smaller list for PH1 — DEC logged).
     */
    public const COMMON_PASSWORDS = [
        'password', 'password1', 'password123', 'passw0rd', '123456', '12345678', '123456789',
        '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcd1234', 'letmein',
        'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'administrator', 'root',
        'toor', 'guest', 'user', 'user123', 'test', 'test123', 'demo', 'demo123', 'changeme',
        'changeit', 'secret', 'secrets', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
        'baseball', 'superman', 'batman', 'trustno1', 'iloveyou', 'whatsoever', 'whatever',
        'computer', 'internet', 'samsung', 'google', 'facebook', 'apple123', 'amazon',
        'master', 'master123', 'hello', 'hello123', 'freedom', 'ninja', 'mustang', 'shadow',
        'michael', 'jennifer', 'jordan23', 'hunter2', 'buster', 'soccer', 'harley', 'andrew',
        'tigger', 'charlie', 'robert', 'thomas', 'hockey', 'killer', 'george', 'asshole',
        'computer1', 'michelle', 'jessica', 'pepper', 'zaq12wsx', '1q2w3e4r', '1qaz2wsx',
        'qazwsx', '123qwe', '123qweasd', 'zxcvbnm', 'asdfghjkl', 'qwertyuiop1', 'password!',
        'p@ssw0rd', 'p@ssword', 'passw0rd!', 'thailand', 'bangkok', 'siam123', 'iloveu1',
        'aaa123456', 'vip123', '666666', '88888888', 'abcdefg1', 'pokemon', 'starwars',
        'letmein1', 'login', 'login123', 'manager', 'manager1', 'access', 'love123',
    ];

    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * Validate a candidate password. Throws AUTH_PASSWORD_WEAK on violation.
     */
    public function assertValid(string $password, string $username): void
    {
        $minLength = $this->settings->int('auth.password.min_length');

        $checks = [
            'min_length' => mb_strlen($password) >= $minLength,
            'max_length' => mb_strlen($password) <= 128,
            'has_letter' => preg_match('/\p{L}/u', $password) === 1,
            'has_digit' => preg_match('/\p{Nd}/u', $password) === 1,
            'not_username' => mb_strtolower($password) !== mb_strtolower($username),
            'not_common' => ! in_array(mb_strtolower($password), self::COMMON_PASSWORDS, true),
        ];

        foreach ($checks as $rule => $ok) {
            if (! $ok) {
                throw new ApiException('AUTH_PASSWORD_WEAK', 'รหัสผ่านไม่ผ่านนโยบายความปลอดภัย', 422, [
                    'rule' => $rule,
                    'min_length' => $minLength,
                ]);
            }
        }
    }
}
