<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** FR-KAN-006 / DEC-055: ordered, exclusive ticket images. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('kanban_ticket_attachments', function (Blueprint $t) {
            $t->foreignUlid('kanban_ticket_id')->constrained('kanban_tickets')->cascadeOnDelete();
            $t->foreignUlid('attachment_id')->unique()->constrained('attachments')->cascadeOnDelete();
            $t->unsignedInteger('position');
            $t->primary(['kanban_ticket_id', 'attachment_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('kanban_ticket_attachments');
    }
};
