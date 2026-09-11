<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('room_calls', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('workspace_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('room_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('started_by')->constrained('users')->cascadeOnDelete();
            $t->string('kind', 10);
            $t->timestampTz('connected_at')->nullable();
            $t->timestampTz('ended_at')->nullable();
            $t->index(['workspace_id', 'ended_at']);
            $t->timestampsTz();
        });
        DB::statement('CREATE UNIQUE INDEX room_calls_one_active ON room_calls (room_id) WHERE ended_at IS NULL');
        Schema::create('call_participants', function (Blueprint $t) {
            $t->ulid('id')->primary();
            $t->foreignUlid('call_id')->constrained('room_calls')->cascadeOnDelete();
            $t->foreignUlid('user_id')->constrained()->cascadeOnDelete();
            $t->foreignUlid('session_id')->constrained('sessions')->cascadeOnDelete();
            $t->timestampTz('left_at')->nullable();
            $t->timestampsTz();
            $t->index(['call_id', 'left_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('call_participants');
        Schema::dropIfExists('room_calls');
    }
};
