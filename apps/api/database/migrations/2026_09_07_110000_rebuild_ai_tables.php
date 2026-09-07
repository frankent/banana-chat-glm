<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

// PH2: replace the PH1 placeholder AI tables with the §4.2 shapes
// (spec 1.1.0 AI Assistant revision). Placeholder tables held no data.
return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('ai_usage_daily');
        Schema::dropIfExists('ai_user_memories');
        Schema::dropIfExists('ai_messages');
        Schema::dropIfExists('ai_conversations');
        Schema::dropIfExists('ai_providers');

        Schema::create('ai_providers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('name', 60);
            $table->string('provider_type', 30)->default('openai_compatible'); // enum in app layer
            $table->string('base_url', 255);
            $table->text('api_key_encrypted');
            $table->char('api_key_last4', 4)->nullable();
            $table->string('model', 100);
            $table->string('model_source', 10)->default('custom'); // list|custom
            $table->unsignedBigInteger('window_size')->default(200000);
            $table->unsignedInteger('max_output_tokens')->default(4096);
            $table->decimal('temperature', 3, 2)->default(0.70);
            $table->text('system_prompt')->nullable();
            $table->string('memory_model', 100)->nullable();
            $table->unsignedInteger('timeout_seconds')->default(60);
            $table->jsonb('extra_headers')->nullable();
            $table->jsonb('capabilities')->nullable();
            $table->boolean('is_enabled')->default(true);
            $table->boolean('is_default')->default(false);
            $table->jsonb('allowed_workspace_ids')->nullable(); // null = all workspaces
            $table->unsignedInteger('daily_message_limit_per_user')->nullable();
            $table->decimal('price_per_1k_in', 10, 5)->nullable();
            $table->decimal('price_per_1k_out', 10, 5)->nullable();
            $table->timestampTz('last_tested_at')->nullable();
            $table->jsonb('last_test_status')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['name']);
        });
        DB::statement('CREATE UNIQUE INDEX ai_providers_single_default_idx ON ai_providers (is_default) WHERE is_default');

        Schema::create('ai_conversations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('title', 100)->nullable();
            $table->string('title_source', 10)->nullable(); // auto|user
            $table->text('summary')->nullable();
            $table->bigInteger('summary_up_to_seq')->default(0);
            $table->unsignedInteger('summary_tokens')->default(0);
            $table->decimal('token_ratio', 6, 3)->nullable();
            $table->bigInteger('last_seq')->default(0);
            $table->unsignedInteger('message_count')->default(0);
            $table->unsignedBigInteger('total_tokens_in')->default(0);
            $table->unsignedBigInteger('total_tokens_out')->default(0);
            $table->timestampTz('last_message_at')->nullable();
            $table->timestampTz('archived_at')->nullable();
            $table->timestampTz('deleted_at')->nullable();
            $table->timestampTz('purge_after')->nullable();
            $table->timestampsTz();

            $table->index(['user_id', 'deleted_at', 'last_message_at']);
        });

        Schema::create('ai_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('conversation_id')->constrained('ai_conversations')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->nullable()->constrained('workspaces')->nullOnDelete();
            $table->bigInteger('seq');
            $table->string('role', 10); // user|assistant
            $table->text('content')->nullable(); // null while pending/streaming (Redis holds the stream)
            $table->string('status', 12)->default('completed'); // pending|streaming|completed|failed|cancelled
            $table->string('error_code', 40)->nullable();
            $table->text('error_detail')->nullable();
            $table->uuid('client_message_id')->nullable();
            $table->foreignUlid('parent_message_id')->nullable();
            $table->timestampTz('superseded_at')->nullable();
            $table->string('model', 100)->nullable();
            $table->string('finish_reason', 20)->nullable();
            $table->unsignedInteger('tokens_prompt')->nullable();
            $table->unsignedInteger('tokens_completion')->nullable();
            $table->string('tokens_source', 12)->nullable(); // provider|estimated
            $table->unsignedInteger('latency_first_token_ms')->nullable();
            $table->unsignedInteger('latency_total_ms')->nullable();
            $table->jsonb('attachments')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('completed_at')->nullable();
            $table->timestampsTz();

            $table->unique(['conversation_id', 'seq']);
            $table->index(['conversation_id', 'seq']);
            $table->index(['conversation_id', 'client_message_id']);
        });
        DB::statement('CREATE INDEX ai_messages_content_trgm_idx ON ai_messages USING GIN (content gin_trgm_ops)');

        Schema::create('ai_user_memories', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('content', 300);
            $table->string('category', 20)->default('other'); // profile|preference|project|other
            $table->unsignedSmallInteger('importance')->default(3); // 1..5
            $table->string('source', 12)->default('extracted'); // extracted|user
            $table->foreignUlid('source_conversation_id')->nullable()->constrained('ai_conversations')->nullOnDelete();
            $table->foreignUlid('source_message_id')->nullable();
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampTz('deleted_at')->nullable();
            $table->timestampsTz();

            $table->index(['user_id', 'importance', 'last_used_at']);
        });
        DB::statement('CREATE INDEX ai_user_memories_content_trgm_idx ON ai_user_memories USING GIN (content gin_trgm_ops)');

        Schema::create('ai_usage_daily', function (Blueprint $table) {
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->nullable()->constrained('workspaces')->nullOnDelete();
            $table->date('date');
            $table->unsignedInteger('messages')->default(0);
            $table->unsignedBigInteger('tokens_in')->default(0);
            $table->unsignedBigInteger('tokens_out')->default(0);
            $table->unsignedBigInteger('tokens_memory')->default(0);
            $table->unsignedInteger('failed')->default(0);
        });
        // workspace_id is nullable — unique expression index instead of a composite PK
        DB::statement("CREATE UNIQUE INDEX ai_usage_daily_unique_idx ON ai_usage_daily (user_id, COALESCE(workspace_id, '00000000000000000000000000'), date)");
    }

    public function down(): void
    {
        // irreversible past PH1 — restoring placeholder shapes serves no purpose
    }
};
