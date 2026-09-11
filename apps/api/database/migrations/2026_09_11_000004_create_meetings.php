<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('meetings', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $t->foreignUlid('created_by')->constrained('users')->cascadeOnDelete();
            $t->string('code', 64)->unique();
            $t->string('title', 120);
            $t->timestampTz('expires_at');
            $t->timestampTz('ended_at')->nullable();
            $t->timestampsTz();
            $t->index(['workspace_id', 'created_by']);
        });
        Schema::create('meeting_participants', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('meeting_id')->constrained('meetings')->cascadeOnDelete();
            $t->foreignUlid('user_id')->nullable()->constrained('users')->cascadeOnDelete();
            $t->foreignUlid('session_id')->nullable()->constrained('sessions')->cascadeOnDelete();
            $t->string('name', 80);
            $t->char('token_hash', 64)->unique();
            $t->timestampTz('left_at')->nullable();
            $t->timestampsTz();
            $t->index(['meeting_id', 'left_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('meeting_participants');
        Schema::dropIfExists('meetings');
    }
};
