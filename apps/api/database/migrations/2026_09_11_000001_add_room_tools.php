<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('room_notes', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('workspace_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('room_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('author_id')->constrained('users');
            $t->text('body')->nullable();
            $t->timestamps();
            $t->index(['room_id', 'id']);
        });
        Schema::create('room_note_attachments', function (Blueprint $t) {
            $t->foreignUlid('room_note_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('attachment_id')->constrained()->cascadeOnDelete();
            $t->primary(['room_note_id', 'attachment_id']);
            $t->unique('attachment_id');
        });
        Schema::create('room_pins', function (Blueprint $t) {
            $t->foreignUlid('room_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('message_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('pinned_by')->constrained('users');
            $t->timestamp('created_at')->useCurrent();
            $t->primary(['room_id', 'message_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('room_pins');
        Schema::dropIfExists('room_note_attachments');
        Schema::dropIfExists('room_notes');
    }
};
