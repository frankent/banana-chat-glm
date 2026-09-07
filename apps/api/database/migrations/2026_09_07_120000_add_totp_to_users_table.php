<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * TASK-ADM-011 / NFR-SEC-012 — TOTP 2FA for system admins.
 * totp_secret is encrypted at rest (APP_KEY); null = not enrolled.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->text('totp_secret')->nullable()->after('ai_consented_at');
            $table->timestamp('totp_enabled_at')->nullable()->after('totp_secret');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn(['totp_secret', 'totp_enabled_at']);
        });
    }
};
