<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workspaces', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('slug')->unique(); // citext below
            $table->string('name', 100);
            $table->ulid('avatar_attachment_id')->nullable();
            $table->string('status', 20)->default('active'); // active|archived
            $table->jsonb('settings')->nullable();
            $table->unsignedInteger('message_retention_days')->nullable();
            $table->unsignedInteger('attachment_retention_days')->nullable();
            $table->timestampsTz();
        });

        DB::statement('ALTER TABLE workspaces ALTER COLUMN slug TYPE citext');

        Schema::create('workspace_members', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('role', 20)->default('member'); // owner|admin|member
            $table->string('status', 20)->default('active'); // active|removed
            $table->timestampTz('joined_at')->useCurrent();
            $table->timestampTz('removed_at')->nullable();
            $table->foreignUlid('invited_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['workspace_id', 'user_id']);
            $table->index(['user_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workspace_members');
        Schema::dropIfExists('workspaces');
    }
};
