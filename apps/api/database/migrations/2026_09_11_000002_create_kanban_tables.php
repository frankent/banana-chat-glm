<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** FR-KAN-001..004: workspace-owned boards and durable deadline state. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('kanban_boards', function (Blueprint $t) {
            $t->foreignUlid('workspace_id')->primary()->constrained('workspaces')->cascadeOnDelete();
            $t->unsignedInteger('next_number')->default(1);
        });
        Schema::create('kanban_lanes', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $t->string('name', 60);
            $t->string('color', 7)->default('#81956b');
            $t->unsignedInteger('position')->default(0);
            $t->boolean('is_done')->default(false);
            $t->timestampsTz();
            $t->index(['workspace_id', 'position']);
            $t->unique(['workspace_id', 'id']);
        });
        Schema::create('kanban_tickets', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $t->ulid('lane_id');
            $t->foreign(['workspace_id', 'lane_id'])->references(['workspace_id', 'id'])->on('kanban_lanes')->restrictOnDelete();
            $t->unsignedInteger('number');
            $t->string('title', 200);
            $t->text('description')->nullable();
            $t->string('type', 10)->default('task');
            $t->string('priority', 10)->default('medium');
            $t->foreignUlid('assignee_id')->nullable()->constrained('users')->nullOnDelete();
            $t->foreignUlid('reporter_id')->nullable()->constrained('users')->nullOnDelete();
            $t->jsonb('labels')->default('[]');
            $t->timestampTz('due_at')->nullable();
            $t->timestampTz('due_notified_at')->nullable();
            $t->unsignedInteger('version')->default(1);
            $t->timestampsTz();
            $t->unique(['workspace_id', 'number']);
            $t->index(['workspace_id', 'lane_id']);
            $t->index(['due_notified_at', 'due_at']);
        });
        Schema::create('kanban_comments', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('ticket_id')->constrained('kanban_tickets')->cascadeOnDelete();
            $t->foreignUlid('author_id')->nullable()->constrained('users')->nullOnDelete();
            $t->text('body');
            $t->timestampsTz();
            $t->index(['ticket_id', 'id']);
        });
        Schema::create('kanban_history', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('ticket_id')->constrained('kanban_tickets')->cascadeOnDelete();
            $t->foreignUlid('actor_id')->nullable()->constrained('users')->nullOnDelete();
            $t->jsonb('changes');
            $t->timestampsTz();
            $t->index(['ticket_id', 'id']);
        });
    }

    public function down(): void
    {
        foreach (['kanban_history', 'kanban_comments', 'kanban_tickets', 'kanban_lanes', 'kanban_boards'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
