<?php

namespace Database\Factories;

use App\Enums\UserStatus;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/** @extends Factory<User> */
class UserFactory extends Factory
{
    protected static ?string $password = null;

    public function definition(): array
    {
        $username = 'user_'.strtolower(Str::random(8));

        return [
            'username' => $username,
            'password_hash' => static::$password ??= Hash::make('Password123!'),
            'display_name' => Str::headline(str_replace('_', ' ', $username)),
            'status' => UserStatus::Active,
            'must_change_password' => false,
            'password_changed_at' => now(),
            'locale' => 'th',
            'timezone' => 'Asia/Bangkok',
            'is_system_admin' => false,
            'failed_login_count' => 0,
        ];
    }

    public function systemAdmin(): static
    {
        return $this->state(fn () => ['is_system_admin' => true]);
    }

    public function suspended(): static
    {
        return $this->state(fn () => ['status' => UserStatus::Suspended]);
    }

    public function deactivated(): static
    {
        return $this->state(fn () => ['status' => UserStatus::Deactivated]);
    }

    public function mustChangePassword(): static
    {
        return $this->state(fn () => ['must_change_password' => true]);
    }

    public function locked(): static
    {
        return $this->state(fn () => [
            'locked_until' => now()->addMinutes(15),
            'failed_login_count' => 10,
        ]);
    }
}
