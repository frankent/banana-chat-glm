<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * FR-PCHAT-001/002/010/020/030 — Public Chat is an ISOLATED BOUNDED CONTEXT
 * (DEC-064). Nothing is added to `rooms`, `messages`, `room_members` or the
 * RoomType enum: a public chat room is not a `rooms` row, which is what makes
 * "no calls, no meetings, never in GET /rooms, never in search, never in the
 * workspace unread badge" structural rather than a gate someone must remember.
 *
 * WORKSPACE ISOLATION (DEC-070). The models DO carry WorkspaceScope — it is
 * protective on Tier 3 (agents), where `workspace.context` middleware has set
 * WorkspaceContext. It is INERT on Tier 1 (HMAC partner) and Tier 2 (visitor,
 * unauthenticated), because those routes resolve a room before any workspace
 * context exists and WorkspaceScope no-ops silently when the context is unset
 * (app/Models/Scopes/WorkspaceScope.php:20). THEREFORE every Tier-1 and Tier-2
 * query MUST ALSO filter workspace_id explicitly, and `workspace_id` is
 * denormalised onto public_chat_messages / public_chat_reads so that even a
 * wrong room_id join cannot cross tenants.
 *
 * Additive and safe on a live database: every statement is a CREATE.
 */
return new class extends Migration
{
    public function up(): void
    {
        // ---- M1 public_chat_api_keys — FR-PCHAT-030/031/032, DEC-062 -------
        // key_id is the PUBLIC identifier named by the signature header and is
        // safe to log; the secret is Crypt::encryptString'd under APP_KEY
        // (DEC-062 — HMAC must recompute the MAC with the key material, so a
        // digest at rest is mathematically unusable). Revocation is a row
        // update, never a delete, so the audit trail survives.
        Schema::create('public_chat_api_keys', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->string('name', 80);
            $table->char('key_id', 32)->unique();     // 'pck_' + 28 lowercase hex
            $table->text('secret_ciphertext');        // model $hidden, never round-tripped
            $table->char('secret_last4', 4);          // display only: '****abcd'
            $table->foreignUlid('created_by_admin_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampTz('revoked_at')->nullable();
            $table->timestampsTz();

            $table->index(['workspace_id', 'revoked_at'], 'public_chat_api_keys_ws_revoked_idx');
        });

        // ---- M2 public_chat_rooms — FR-PCHAT-001/009/012 --------------------
        Schema::create('public_chat_rooms', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            // provenance only — revoking the key does NOT close rooms it created
            $table->foreignUlid('api_key_id')->nullable()->constrained('public_chat_api_keys')->nullOnDelete();
            $table->char('code', 64)->unique();       // bin2hex(random_bytes(32)); the visitor credential (DEC-063)
            $table->string('customer_name', 120);
            $table->string('provider_name', 120);
            $table->string('status', 12)->default('new'); // new|in_progress|done|problem
            $table->foreignUlid('assigned_to')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('claimed_at')->nullable();
            // MANDATORY graft 21 — stamped by the same auto-claim UPDATE; one
            // timestamp yields first-response-time, the metric support is judged on.
            $table->timestampTz('first_response_at')->nullable();
            $table->string('external_ref', 120)->nullable(); // the partner's own ticket id
            $table->jsonb('meta')->nullable();               // NEVER served to the visitor
            $table->char('locale', 2)->default('th');        // FR-I18N-001 default
            $table->integer('last_seq')->default(0);
            $table->integer('last_visitor_seq')->default(0);
            $table->integer('last_agent_seq')->default(0);
            $table->timestampTz('last_message_at')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->timestampsTz();
            $table->softDeletesTz();

            $table->index(['workspace_id', 'assigned_to'], 'public_chat_rooms_ws_assignee_idx');
        });

        // Blueprint cannot express DESC ordering or a partial unique index.
        DB::statement('CREATE INDEX public_chat_rooms_ws_status_recent_idx
            ON public_chat_rooms (workspace_id, status, last_message_at DESC)');

        // API-200 create idempotency (FR-PCHAT-011). DELIBERATELY excludes
        // api_key_id: a key rotation (revoke+issue) changes api_key_id, and
        // including it would make the partner's retry-after-rotation create a
        // duplicate room instead of replaying the original one.
        DB::statement('CREATE UNIQUE INDEX public_chat_rooms_ws_external_ref_uniq
            ON public_chat_rooms (workspace_id, external_ref)
            WHERE external_ref IS NOT NULL');

        // ---- M3 public_chat_messages — FR-PCHAT-002 ------------------------
        Schema::create('public_chat_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('room_id')->constrained('public_chat_rooms')->cascadeOnDelete();
            // DENORMALISED defence-in-depth (DEC-070): every query also filters
            // workspace_id, so even a wrong room_id join cannot cross tenants.
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->integer('seq');
            $table->string('sender_kind', 8);   // visitor|agent|system
            $table->foreignUlid('sender_user_id')->nullable()->constrained('users')->nullOnDelete();
            // WRITE-TIME SNAPSHOTS: the public serializer computes the external
            // display name from these and NEVER joins `users`. A later username
            // change does not retroactively rewrite the customer's transcript,
            // and a buggy join cannot leak a user row onto the public surface.
            $table->string('agent_username_snapshot', 64)->nullable();
            $table->string('provider_name_snapshot', 120)->nullable();
            $table->string('type', 8);          // text|image|video|file|system
            $table->text('body')->nullable();
            $table->string('system_event', 24)->nullable(); // claimed|reassigned|status_changed|closed_by_customer
            // system rows have body NULL so each serializer renders the text in
            // the READER's locale (a baked-in Thai string is unreadable to an
            // 'en' visitor and vice versa).
            $table->jsonb('system_meta')->nullable();
            // MANDATORY graft 4 — reply/quote. The public payload exposes a
            // snippet only, never the replied-to message's sender identity.
            $table->ulid('reply_to_message_id')->nullable();
            // DEC-066 — NOT NULL so no column of the idempotency key is
            // nullable: Postgres treats NULLs as distinct, which is exactly what
            // makes messages(room_id, sender_id, client_message_id) inert for
            // NULL-sender rows today. Visitor ids must be UUID (422 otherwise),
            // agent ids are crypto.randomUUID(), and SYSTEM ROWS GET A
            // SERVER-GENERATED ULID (graft 11) — they have no client, and
            // without this the first status change violates the constraint.
            $table->string('client_message_id', 64);
            $table->timestampTz('created_at')->nullable();
            $table->timestampTz('deleted_at')->nullable();
            $table->foreignUlid('deleted_by')->nullable()->constrained('users')->nullOnDelete();

            $table->unique(['room_id', 'seq'], 'public_chat_messages_room_seq_uniq');
            // MANDATORY graft 13 / pinned decision 4 — sender_kind is PART OF
            // the key. Without it a visitor (who supplies a free-form id) can
            // squat an agent's client_message_id and the agent's send silently
            // returns the visitor's message as a 200 idempotent replay.
            $table->unique(['room_id', 'sender_kind', 'client_message_id'], 'public_chat_messages_idem_uniq');
        });

        // Self-FK needs its own statement on Postgres (PK not yet visible inline) —
        // same shape as 2026_09_07_000005_create_messages_table.php.
        Schema::table('public_chat_messages', function (Blueprint $table) {
            $table->foreign('reply_to_message_id')->references('id')->on('public_chat_messages')->nullOnDelete();
        });

        DB::statement('CREATE INDEX public_chat_messages_room_seq_desc_idx
            ON public_chat_messages (room_id, seq DESC)');
        DB::statement('CREATE INDEX public_chat_messages_ws_created_idx
            ON public_chat_messages (workspace_id, created_at)');
        // MANDATORY graft 2 — API-220's `q` must match what the customer
        // actually said, via an EXISTS subquery over body. pg_trgm is enabled
        // by 2026_09_07_000001; without this index that ILIKE is a seq scan.
        DB::statement('CREATE INDEX public_chat_messages_body_trgm_idx
            ON public_chat_messages USING GIN (body gin_trgm_ops)');

        // ---- M4 public_chat_message_attachments ---------------------------
        // Separate from `message_attachments`, whose FK points at `messages`.
        // Reusing it would require making that FK nullable or polymorphic —
        // exactly the contamination this bounded context exists to prevent.
        Schema::create('public_chat_message_attachments', function (Blueprint $table) {
            $table->foreignUlid('message_id')->constrained('public_chat_messages')->cascadeOnDelete();
            $table->foreignUlid('attachment_id')->constrained('attachments')->cascadeOnDelete();
            $table->unsignedSmallInteger('position')->default(0);
            $table->primary(['message_id', 'attachment_id']);
        });

        // ---- M5 public_chat_reads — FR-PCHAT-010, MANDATORY graft 15 -------
        // Per-agent read pointer. There are no room_members rows here, so this
        // tiny table is what lets an agent see "I have 3 unread in this room"
        // instead of only the room-level needs_reply signal. API-228 writes it
        // monotonically (a lower seq is a no-op); it NEVER affects queue order.
        Schema::create('public_chat_reads', function (Blueprint $table) {
            $table->foreignUlid('room_id')->constrained('public_chat_rooms')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->integer('last_read_seq')->default(0);
            $table->timestampTz('last_read_at')->nullable();
            $table->primary(['room_id', 'user_id']);
            $table->index(['user_id', 'workspace_id'], 'public_chat_reads_user_ws_idx');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('public_chat_reads');
        Schema::dropIfExists('public_chat_message_attachments');
        DB::statement('DROP INDEX IF EXISTS public_chat_messages_body_trgm_idx');
        DB::statement('DROP INDEX IF EXISTS public_chat_messages_ws_created_idx');
        DB::statement('DROP INDEX IF EXISTS public_chat_messages_room_seq_desc_idx');
        Schema::dropIfExists('public_chat_messages');
        DB::statement('DROP INDEX IF EXISTS public_chat_rooms_ws_external_ref_uniq');
        DB::statement('DROP INDEX IF EXISTS public_chat_rooms_ws_status_recent_idx');
        Schema::dropIfExists('public_chat_rooms');
        Schema::dropIfExists('public_chat_api_keys');
    }
};
