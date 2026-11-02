<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('public_chat_rooms', function (Blueprint $table) {
            $table->string('kind', 8)->default('support'); // support|group
            $table->string('password_hash')->nullable();   // group rooms only; bcrypt
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
        });

        Schema::create('public_chat_guests', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('room_id')->constrained('public_chat_rooms')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->constrained('workspaces')->cascadeOnDelete();
            $table->string('display_name', 40);
            $table->char('token_hash', 64)->unique(); // sha256 of the guest token; token is never stored
            $table->timestampTz('last_seen_at')->nullable();
            $table->timestampTz('revoked_at')->nullable();
            $table->timestampsTz();

            $table->index(['room_id', 'revoked_at'], 'public_chat_guests_room_revoked_idx');
        });

        // One identity per name per room: re-entering with the same name resumes the same guest.
        DB::statement('CREATE UNIQUE INDEX public_chat_guests_room_name_uniq
            ON public_chat_guests (room_id, lower(display_name))');

        Schema::table('public_chat_messages', function (Blueprint $table) {
            $table->foreignUlid('guest_id')->nullable()->constrained('public_chat_guests')->nullOnDelete();
            $table->string('guest_name_snapshot', 40)->nullable();
            $table->dropUnique('public_chat_messages_idem_uniq');
        });

        // Two guests may legitimately reuse a client_message_id; guest_id joins the key.
        DB::statement("CREATE UNIQUE INDEX public_chat_messages_idem_uniq
            ON public_chat_messages (room_id, sender_kind, COALESCE(guest_id, ''), client_message_id)");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS public_chat_messages_idem_uniq');

        Schema::table('public_chat_messages', function (Blueprint $table) {
            $table->dropConstrainedForeignId('guest_id');
            $table->dropColumn('guest_name_snapshot');
            $table->unique(['room_id', 'sender_kind', 'client_message_id'], 'public_chat_messages_idem_uniq');
        });

        Schema::dropIfExists('public_chat_guests');

        Schema::table('public_chat_rooms', function (Blueprint $table) {
            $table->dropConstrainedForeignId('created_by');
            $table->dropColumn(['kind', 'password_hash']);
        });
    }
};
