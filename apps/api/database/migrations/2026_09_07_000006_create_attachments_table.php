<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('attachments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->foreignUlid('uploader_id')->constrained('users')->cascadeOnDelete();
            $table->string('kind', 10); // image|video|file|avatar
            $table->string('status', 12)->default('pending'); // pending|uploaded|processing|ready|failed|deleted
            $table->string('original_name', 255);
            $table->string('mime_type', 127);
            $table->bigInteger('size_bytes');
            $table->string('storage_key', 512);
            $table->char('checksum_sha256', 64)->nullable();
            $table->unsignedInteger('width')->nullable();
            $table->unsignedInteger('height')->nullable();
            $table->unsignedInteger('duration_ms')->nullable();
            $table->jsonb('derived')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->timestampTz('deleted_at')->nullable();
            $table->timestampsTz();

            $table->index(['status', 'expires_at']);
            $table->index(['workspace_id', 'kind']);
        });

        Schema::create('message_attachments', function (Blueprint $table) {
            $table->foreignUlid('message_id')->constrained('messages')->cascadeOnDelete();
            $table->foreignUlid('attachment_id')->constrained('attachments')->cascadeOnDelete();
            $table->unsignedSmallInteger('position')->default(0);
            $table->primary(['message_id', 'attachment_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('message_attachments');
        Schema::dropIfExists('attachments');
    }
};
