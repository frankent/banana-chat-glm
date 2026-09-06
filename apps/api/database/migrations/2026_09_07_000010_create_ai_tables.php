<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

// AI tables per spec §4.2 — schema only; features are PH2 (out of scope this build).
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_providers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('name', 50)->unique();
            $table->string('adapter', 20); // openai|anthropic|google
            $table->jsonb('credentials'); // encrypted at rest by app layer
            $table->string('default_model', 100)->nullable();
            $table->boolean('is_active')->default(true);
            $table->timestampsTz();
        });

        Schema::create('ai_conversations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->string('title', 200)->nullable();
            $table->jsonb('context')->nullable();
            $table->timestampTz('last_message_at')->nullable();
            $table->timestampsTz();

            $table->index(['user_id', 'workspace_id']);
        });

        Schema::create('ai_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('conversation_id')->constrained('ai_conversations')->cascadeOnDelete();
            $table->string('role', 10); // user|assistant
            $table->text('content');
            $table->jsonb('metadata')->nullable();
            $table->timestampsTz();

            $table->index(['conversation_id', 'created_at']);
        });
        DB::statement('CREATE INDEX ai_messages_content_trgm_idx ON ai_messages USING GIN (content gin_trgm_ops)');

        Schema::create('ai_user_memories', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->text('content');
            $table->timestampTz('expires_at')->nullable();
            $table->timestampsTz();
        });

        Schema::create('ai_usage_daily', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->nullable()->constrained('workspaces')->nullOnDelete();
            $table->date('date');
            $table->unsignedBigInteger('requests')->default(0);
            $table->unsignedBigInteger('tokens_in')->default(0);
            $table->unsignedBigInteger('tokens_out')->default(0);
            $table->timestampsTz();
        });
        // PK cols can't be NULL — unique expression index instead
        DB::statement("CREATE UNIQUE INDEX ai_usage_daily_unique_idx ON ai_usage_daily (user_id, COALESCE(workspace_id, '00000000000000000000000000'), date)");
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_usage_daily');
        Schema::dropIfExists('ai_user_memories');
        Schema::dropIfExists('ai_messages');
        Schema::dropIfExists('ai_conversations');
        Schema::dropIfExists('ai_providers');
    }
};
