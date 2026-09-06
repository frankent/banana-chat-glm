<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// Spec §4.2: sessions = login sessions with rotating refresh tokens.
// (Laravel's own `sessions` cache-table migration is untouched — we use redis sessions.)
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('devices', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('platform', 10); // ios|android|web
            $table->text('push_token')->nullable();
            $table->string('push_provider', 10)->nullable(); // fcm|apns
            $table->string('app_version', 20)->nullable();
            $table->string('device_name', 100)->nullable();
            $table->string('locale', 5)->nullable();
            $table->timestampTz('last_active_at')->nullable();
            $table->unsignedInteger('push_failed_count')->default(0);
            $table->timestampTz('push_disabled_at')->nullable();
            $table->timestampsTz();

            $table->unique(['user_id', 'push_token']);
        });

        Schema::create('sessions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->char('refresh_token_hash', 64)->unique();
            $table->char('prev_refresh_token_hash', 64)->nullable()->index(); // reuse detection
            $table->foreignUlid('device_id')->nullable()->constrained('devices')->nullOnDelete();
            $table->ipAddress('ip')->nullable();
            $table->text('user_agent')->nullable();
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampTz('expires_at');
            $table->timestampTz('revoked_at')->nullable();
            $table->string('revoked_reason', 20)->nullable(); // logout|admin|password_change|rotation|expired
            $table->timestampsTz();

            $table->index(['user_id', 'revoked_at']);
        });

        Schema::create('access_tokens', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('session_id')->constrained('sessions')->cascadeOnDelete();
            $table->char('token_hash', 64)->unique();
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampTz('expires_at');
            $table->timestampTz('revoked_at')->nullable();
            $table->timestampsTz();

            $table->index(['user_id', 'revoked_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('access_tokens');
        Schema::dropIfExists('sessions');
        Schema::dropIfExists('devices');
    }
};
