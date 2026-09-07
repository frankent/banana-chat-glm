<?php

namespace App\Domain\Admin;

use App\Models\User;
use App\Services\AuditLogger;
use PragmaRX\Google2FA\Google2FA;

/**
 * TASK-ADM-011 / NFR-SEC-012 — TOTP enrollment + verification for the
 * admin panel. Enrollment is per-admin opt-in (Security page in Filament);
 * login demands the 6-digit code once totp_enabled_at is set.
 */
class TotpService
{
    public function __construct(
        private readonly AuditLogger $audit,
    ) {}

    public function generateSecret(): string
    {
        return (new Google2FA)->generateSecretKey(32);
    }

    public function otpauthUri(User $admin, string $secret): string
    {
        return (new Google2FA)->getQRCodeUrl('Banana Chat Admin', $admin->username, $secret);
    }

    public function verify(User $admin, string $code): bool
    {
        if ($admin->totp_secret === null || $code === '') {
            return false;
        }

        return (new Google2FA)->verifyKey($admin->totp_secret, $code, 1);
    }

    /** Verify the code against a candidate secret and enroll. */
    public function enroll(User $admin, string $secret, string $code): bool
    {
        if (! (new Google2FA)->verifyKey($secret, $code, 1)) {
            return false;
        }

        $admin->forceFill([
            'totp_secret' => $secret,
            'totp_enabled_at' => now(),
        ])->save();

        $this->audit->log('admin.2fa_enabled', $admin, 'user', $admin->id);

        return true;
    }

    public function disable(User $admin): void
    {
        $admin->forceFill([
            'totp_secret' => null,
            'totp_enabled_at' => null,
        ])->save();

        $this->audit->log('admin.2fa_disabled', $admin, 'user', $admin->id);
    }
}
