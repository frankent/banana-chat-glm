<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('room_notification_settings', function (Blueprint $table) {
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('room_id')->constrained('rooms')->cascadeOnDelete();
            $table->string('mode', 10)->default('all'); // all|mentions|none
            $table->timestampTz('muted_until')->nullable();
            $table->primary(['user_id', 'room_id']);
        });

        Schema::create('user_notification_settings', function (Blueprint $table) {
            $table->foreignUlid('user_id')->primary()->constrained('users')->cascadeOnDelete();
            $table->timeTz('dnd_start')->nullable();
            $table->timeTz('dnd_end')->nullable();
            $table->jsonb('dnd_days')->nullable(); // int[] as jsonb (DEC: simplification)
            $table->boolean('sound')->default(true);
            $table->boolean('preview_in_push')->default(true);
            $table->timestampsTz();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_notification_settings');
        Schema::dropIfExists('room_notification_settings');
    }
};
