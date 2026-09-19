<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * R6 (REVIEW.md 2026-09-19) — FR-AUTH-002 reuse detection only ever checked
 * the immediate predecessor via `sessions.prev_refresh_token_hash`. Replaying
 * R0 after R0 → R1 → R2 matched neither stored hash and returned a generic
 * invalid-token error instead of revoking the session. This table retains
 * every consumed hash for the session's lifetime instead of just the last
 * one; `prev_refresh_token_hash` is fully subsumed and dropped.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('refresh_token_lineage', function (Blueprint $table) {
            $table->char('token_hash', 64)->primary();
            $table->foreignUlid('session_id')->constrained('sessions')->cascadeOnDelete();
            $table->timestampTz('rotated_at');

            $table->index('session_id');
        });

        Schema::table('sessions', function (Blueprint $table) {
            $table->dropColumn('prev_refresh_token_hash');
        });
    }

    public function down(): void
    {
        Schema::table('sessions', function (Blueprint $table) {
            $table->char('prev_refresh_token_hash', 64)->nullable()->index();
        });

        Schema::dropIfExists('refresh_token_lineage');
    }
};
