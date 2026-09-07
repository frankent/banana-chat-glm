<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-NOTI-002 — devices report the room the client is looking at
 * (POST /me/focus every ~20s); push suppression reads it here.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->foreignUlid('focused_room_id')->nullable()->constrained('rooms')->nullOnDelete();
            $table->timestampTz('focused_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('devices', function (Blueprint $table) {
            $table->dropConstrainedForeignId('focused_room_id');
            $table->dropColumn('focused_at');
        });
    }
};
