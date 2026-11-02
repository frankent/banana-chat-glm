<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// FR-PCHAT-042 — a group room may own one video meeting. The meeting's own
// public code is never disclosed; access goes through the room's guest token.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('public_chat_rooms', function (Blueprint $t) {
            $t->foreignUlid('meeting_id')->nullable()->constrained('meetings')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('public_chat_rooms', function (Blueprint $t) {
            $t->dropConstrainedForeignId('meeting_id');
        });
    }
};
