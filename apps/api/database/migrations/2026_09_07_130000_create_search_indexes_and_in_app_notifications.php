<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * TASK-BE-022 — search indexes (pg_trgm for Thai substring match, DEC-010)
 * and TASK-BE-027 — in-app notification center table (FR-NOTI-006).
 */
return new class extends Migration
{
    public function up(): void
    {
        // Thai has no word boundaries for Postgres FTS → trigram index backs
        // the ILIKE path; English keeps the existing body_search tsvector.
        DB::statement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        DB::statement('CREATE INDEX messages_body_trgm_idx ON messages USING GIN (body gin_trgm_ops)');
        DB::statement('CREATE INDEX attachments_original_name_trgm_idx ON attachments USING GIN (original_name gin_trgm_ops)');

        Schema::create('in_app_notifications', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->nullable()->constrained('workspaces')->cascadeOnDelete();
            $table->string('type', 20); // mention|added_to_room|session_revoked
            $table->foreignUlid('room_id')->nullable()->constrained('rooms')->cascadeOnDelete();
            $table->foreignUlid('actor_id')->nullable()->constrained('users')->nullOnDelete();
            $table->jsonb('data')->nullable();
            $table->timestampTz('read_at')->nullable();
            $table->timestampsTz();

            $table->index(['user_id', 'created_at']);
            $table->index(['user_id', 'read_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('in_app_notifications');
        DB::statement('DROP INDEX IF EXISTS attachments_original_name_trgm_idx');
        DB::statement('DROP INDEX IF EXISTS messages_body_trgm_idx');
        // pg_trgm may be shared with other consumers — leave the extension installed
    }
};
