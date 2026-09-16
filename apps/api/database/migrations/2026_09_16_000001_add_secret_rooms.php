<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-ROOM-012 / DEC-056 — secret rooms: creator-chosen expiry (1..30 days
 * from creation). `is_secret` + `secret_expires_at` drive immediate access
 * denial at expiry; the ExpireSecretRooms scheduler purges the room through
 * the existing deletion lifecycle. Ordinary rooms keep both columns at the
 * defaults and behave exactly as before.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('rooms', function (Blueprint $table) {
            $table->boolean('is_secret')->default(false);
            $table->timestampTz('secret_expires_at')->nullable();
            $table->index(['secret_expires_at'], 'rooms_secret_expiry_idx');
        });
    }

    public function down(): void
    {
        Schema::table('rooms', function (Blueprint $table) {
            $table->dropIndex('rooms_secret_expiry_idx');
            $table->dropColumn(['is_secret', 'secret_expires_at']);
        });
    }
};
