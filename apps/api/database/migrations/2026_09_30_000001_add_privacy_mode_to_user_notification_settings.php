<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-NOTI-008/009 / DEC-087 — per-user "Privacy mode". Server-side boolean
 * because push titles/bodies are built on the server (FcmPushSender): a
 * per-device flag could not mask what the server already decided to say.
 * Superset of preview_in_push (which keeps its own behaviour when this is off).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('user_notification_settings', function (Blueprint $table) {
            $table->boolean('privacy_mode')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('user_notification_settings', function (Blueprint $table) {
            $table->dropColumn('privacy_mode');
        });
    }
};
