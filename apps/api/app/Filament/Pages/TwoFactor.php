<?php

namespace App\Filament\Pages;

use App\Domain\Admin\TotpService;
use App\Models\User;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

/**
 * TASK-ADM-011 — per-admin TOTP enrollment (NFR-SEC-012).
 *
 * Flow: generate a secret → add it to any authenticator app (otpauth URI) →
 * confirm with one live code. The secret is stored encrypted (APP_KEY) and
 * every enable/disable is audited.
 */
class TwoFactor extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-shield-check';

    protected static ?string $navigationLabel = '2FA (TOTP)';

    protected static ?string $title = 'Two-Factor Authentication';

    protected static ?int $navigationSort = 9;

    protected static string $view = 'filament.pages.two-factor';

    public ?array $data = [];

    public ?string $pendingSecret = null;

    public function mount(): void
    {
        $this->form->fill();
    }

    public function form(Form $form): Form
    {
        return $form
            ->schema([
                TextInput::make('code')
                    ->label('รหัสยืนยัน 6 หลักจากแอป Authenticator')
                    ->numeric()
                    ->length(6)
                    ->required(),
            ])
            ->statePath('data');
    }

    public function generateSecret(TotpService $totp): void
    {
        $this->pendingSecret = $totp->generateSecret();
    }

    /** otpauth:// URI for authenticator apps that accept links. */
    public function pendingOtpauthUri(TotpService $totp): string
    {
        if ($this->pendingSecret === null) {
            return '';
        }

        return $totp->otpauthUri(auth('admin')->user(), $this->pendingSecret);
    }

    public function confirm(TotpService $totp): void
    {
        if ($this->pendingSecret === null) {
            $this->generateSecret($totp);
            Notification::make()->title('สร้างรหัสลับใหม่แล้ว กรุณายืนยันด้วยรหัส 6 หลัก')->info()->send();

            return;
        }

        $data = $this->form->getState();

        if (! $totp->enroll(auth('admin')->user(), $this->pendingSecret, (string) ($data['code'] ?? ''))) {
            Notification::make()->title('รหัสยืนยันไม่ถูกต้อง ลองอีกครั้ง')->danger()->send();

            return;
        }

        $this->pendingSecret = null;
        Notification::make()->title('เปิดใช้ 2FA เรียบร้อย')->success()->send();
    }

    public function disable(TotpService $totp): void
    {
        $totp->disable(auth('admin')->user());
        Notification::make()->title('ปิดใช้ 2FA เรียบร้อย')->warning()->send();
    }

    public function isEnabled(): bool
    {
        $user = auth('admin')->user();

        return $user instanceof User && $user->totp_enabled_at !== null;
    }
}
