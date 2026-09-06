<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('rooms', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->string('type', 10); // dm|group
            $table->string('name', 100)->nullable();
            $table->string('description', 500)->nullable();
            $table->ulid('avatar_attachment_id')->nullable();
            $table->string('dm_key', 64)->nullable()->unique();
            $table->foreignUlid('created_by')->constrained('users');
            $table->foreignUlid('owner_id')->nullable()->constrained('users')->nullOnDelete();
            $table->bigInteger('last_seq')->default(0);
            $table->bigInteger('last_user_seq')->default(0);
            $table->ulid('last_message_id')->nullable();
            $table->timestampTz('last_message_at')->nullable();
            $table->unsignedInteger('member_count')->default(0);
            $table->jsonb('settings')->nullable();
            $table->timestampTz('deleted_at')->nullable();
            $table->timestampTz('purge_after')->nullable();
            $table->timestampsTz();

            $table->index(['workspace_id', 'last_message_at']);
            $table->index(['workspace_id', 'type']);
        });

        Schema::create('room_members', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('room_id')->constrained('rooms')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->string('role', 20)->default('member'); // owner|admin|member
            $table->bigInteger('last_read_seq')->default(0);
            $table->timestampTz('last_read_at')->nullable();
            $table->timestampTz('joined_at')->useCurrent();
            $table->timestampTz('left_at')->nullable();
            $table->timestampTz('hidden_at')->nullable();
            $table->timestampTz('pinned_at')->nullable();
            $table->foreignUlid('added_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['room_id', 'user_id']);
            $table->index(['user_id', 'workspace_id', 'left_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('room_members');
        Schema::dropIfExists('rooms');
    }
};
