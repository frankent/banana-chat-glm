<?php

namespace App\Filament\Pages\Auth;

use App\Domain\Admin\TotpService;
use App\Models\User;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Form;
use Filament\Http\Responses\Auth\Contracts\LoginResponse;
use Filament\Pages\Auth\Login as BaseLogin;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

/**
 * Username login for the admin panel — the users table has no email column.
 *
 * TASK-ADM-011 / NFR-SEC-012: admins enrolled in TOTP must also present a
 * valid 6-digit code. The check runs only after the password itself matches,
 * so an attacker without the password learns nothing about enrollment.
 */
class Login extends BaseLogin
{
    public function form(Form $form): Form
    {
        return $form
            ->schema([
                TextInput::make('login')
                    ->label('Username')
                    ->required()
                    ->autocomplete('username'),
                TextInput::make('password')
                    ->label(__('filament-panels::pages/auth/login.form.password.label'))
                    ->password()
                    ->revealable(filament()->arePasswordsRevealable())
                    ->autocomplete('current-password')
                    ->required()
                    ->extraAttributes(['tabindex' => 2]),
                TextInput::make('totp')
                    ->label('รหัส 2FA (ถ้าเปิดใช้งาน)')
                    ->numeric()
                    ->length(6)
                    ->autocomplete('one-time-code')
                    ->extraAttributes(['tabindex' => 3]),
            ])
            ->statePath('data');
    }

    protected function getCredentialsFromFormData(array $data): array
    {
        return [
            'username' => $data['login'],
            'password' => $data['password'],
        ];
    }

    public function authenticate(): ?LoginResponse
    {
        $data = $this->form->getRawState();

        $user = User::query()
            ->where('username', $data['login'] ?? '')
            ->where('is_system_admin', true)
            ->first();

        // TOTP gate — password verified first (no enrollment oracle)
        if ($user !== null
            && $user->totp_enabled_at !== null
            && Hash::check($data['password'] ?? '', $user->password_hash)
            && ! app(TotpService::class)->verify($user, (string) ($data['totp'] ?? ''))) {
            throw ValidationException::withMessages([
                'data.totp' => 'รหัส 2FA ไม่ถูกต้องหรือหมดอายุ',
            ]);
        }

        return parent::authenticate();
    }
}
