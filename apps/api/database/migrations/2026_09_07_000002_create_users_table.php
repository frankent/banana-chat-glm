<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('username')->unique(); // converted to citext below
            $table->text('password_hash');
            $table->string('display_name', 80);
            $table->ulid('avatar_attachment_id')->nullable(); // FK added post-attachments (circular); app-enforced
            $table->string('status', 20)->default('active')->index(); // active|suspended|deactivated
            $table->boolean('must_change_password')->default(true);
            $table->timestampTz('password_changed_at')->nullable();
            $table->unsignedInteger('failed_login_count')->default(0);
            $table->timestampTz('locked_until')->nullable();
            $table->timestampTz('last_seen_at')->nullable();
            $table->string('locale', 5)->default('th');
            $table->string('timezone', 64)->default('Asia/Bangkok');
            $table->boolean('is_system_admin')->default(false);
            $table->string('auth_provider', 20)->default('local');
            $table->ulid('created_by')->nullable();
            $table->boolean('ai_memory_enabled')->default(true);
            $table->timestampTz('ai_consented_at')->nullable();
            $table->rememberToken();
            $table->timestampsTz();
        });

        DB::statement('ALTER TABLE users ALTER COLUMN username TYPE citext');
    }

    public function down(): void
    {
        Schema::dropIfExists('users');
    }
};
