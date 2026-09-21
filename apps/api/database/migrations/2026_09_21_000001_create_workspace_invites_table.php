<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-WS-006 / FR-AUTH-008 / DEC-081 — owner/admin-issued, single-use,
 * time-limited invite that lets a brand-new person register and join this
 * workspace as role=member. `token_hash` mirrors TokenService's opaque
 * bearer-token convention (sha256 of a random value, never stored plaintext)
 * rather than PublicChatRoom's plaintext `code` — this credential creates an
 * account, so it gets the stronger treatment.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workspace_invites', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->foreignUlid('created_by')->constrained('users')->cascadeOnDelete();
            $table->char('token_hash', 64)->unique();
            $table->timestampTz('expires_at');
            $table->timestampTz('used_at')->nullable();
            $table->foreignUlid('used_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('revoked_at')->nullable();
            $table->timestampsTz();

            $table->index(['workspace_id', 'used_at', 'revoked_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workspace_invites');
    }
};
