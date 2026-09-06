<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('room_id')->constrained('rooms')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->foreignUlid('sender_id')->nullable()->constrained('users')->nullOnDelete();
            $table->bigInteger('seq');
            $table->string('type', 10); // text|image|video|file|system
            $table->text('body')->nullable();
            $table->uuid('client_message_id')->nullable();
            $table->ulid('reply_to_message_id')->nullable();
            $table->jsonb('system_event')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->timestampTz('edited_at')->nullable();
            $table->unsignedInteger('edit_count')->default(0);
            $table->timestampTz('deleted_at')->nullable();
            $table->foreignUlid('deleted_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('delete_reason', 20)->nullable(); // sender|moderator|retention
            $table->timestampsTz();

            $table->unique(['room_id', 'seq']);
            $table->unique(['room_id', 'sender_id', 'client_message_id']);
            $table->index(['room_id', 'seq']);
            $table->index(['workspace_id', 'created_at']);
        });

        // Self-FK needs its own statement on Postgres (PK not yet visible inline)
        Schema::table('messages', function (Blueprint $table) {
            $table->foreign('reply_to_message_id')->references('id')->on('messages')->nullOnDelete();
        });

        // FTS: generated column — English via 'simple' dictionary, Thai via trgm in search layer (DEC-010)
        DB::statement("ALTER TABLE messages ADD COLUMN body_search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED");
        DB::statement('CREATE INDEX messages_body_search_idx ON messages USING GIN (body_search)');

        Schema::create('message_edits', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('message_id')->constrained('messages')->cascadeOnDelete();
            $table->text('previous_body');
            $table->foreignUlid('edited_by')->constrained('users');
            $table->timestampTz('edited_at')->useCurrent();
        });

        Schema::create('message_mentions', function (Blueprint $table) {
            $table->foreignUlid('message_id')->constrained('messages')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->primary(['message_id', 'user_id']);
            $table->index(['user_id', 'workspace_id']);
        });

        Schema::create('message_reactions', function (Blueprint $table) {
            $table->foreignUlid('message_id')->constrained('messages')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->string('emoji', 32);
            $table->primary(['message_id', 'user_id', 'emoji']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('message_reactions');
        Schema::dropIfExists('message_mentions');
        Schema::dropIfExists('message_edits');
        DB::statement('DROP INDEX IF EXISTS messages_body_search_idx');
        Schema::dropIfExists('messages');
    }
};
