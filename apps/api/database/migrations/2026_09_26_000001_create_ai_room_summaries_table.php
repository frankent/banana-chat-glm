<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * DEC-085 — the room bot's rolling summary of messages it has already been
 * sent. One row per room; dropped with the room, and whenever a message it
 * covers is edited or deleted.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_room_summaries', function (Blueprint $table) {
            $table->foreignUlid('room_id')->primary()->constrained('rooms')->cascadeOnDelete();
            $table->text('summary');
            $table->bigInteger('from_seq');
            $table->bigInteger('up_to_seq');
            $table->integer('summary_tokens')->default(0);
            $table->timestampTz('source_read_at'); // covered rows were read at this instant
            $table->timestampsTz();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_room_summaries');
    }
};
