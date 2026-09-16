<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * FR-PCHAT-020 / DEC-068 — the ONE surface Public Chat shares with the rest of
 * the product: the media pipeline. `attachments` + UploadService are reused and
 * PARTITIONED by a new nullable `public_chat_room_id`, because forking mime
 * sniffing, the blocked-extension deny list and the per-kind size caps would
 * guarantee drift in exactly the checks that matter. The shared code IS the
 * security code.
 *
 * WHY uploader_id MUST BECOME NULLABLE: it is
 * `foreignUlid('uploader_id')->constrained('users')->cascadeOnDelete()` today
 * (2026_09_07_000006_create_attachments_table.php:14) — NOT NULL, unlike
 * messages.sender_id. A visitor has no User row, so visitor file/image/video
 * upload is not merely broken, it is IMPOSSIBLE until this lands.
 *
 * The partition is enforced on both sides:
 *  - internal claim paths add ->whereNull('public_chat_room_id');
 *  - the public claim requires public_chat_room_id === $room->id, a ROOM-scoped
 *    (not uploader-scoped) ownership test;
 *  - MessageWriter.php:175, RoomToolsController.php:56 and BoardService.php:122
 *    all compare `uploader_id === $actor->id`, and NULL never equals a ULID, so
 *    the internal claim paths are naturally FAIL-CLOSED against visitor uploads
 *    even if an explicit guard were removed;
 *  - and `attachments_owner_chk` below makes "owned by nobody" unrepresentable
 *    at the database level (MANDATORY grafts 17/25 — the cheapest possible
 *    backstop on the single shared surface, which is this design's R6).
 *
 * LIVE-DATABASE SAFETY: ALTER COLUMN DROP NOT NULL is a catalog-only change.
 * ADD COLUMN of a nullable column with no default is catalog-only on PG 11+.
 * The CHECK constraint is added NOT VALID (no table scan, ACCESS EXCLUSIVE held
 * only for the catalog update) and then VALIDATEd under a weaker SHARE UPDATE
 * EXCLUSIVE lock that does not block reads or writes. No data is destroyed.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Raw DDL, not ->change(): Laravel 11+ column modification rewrites the
        // column definition from the Blueprint alone and silently drops modifiers
        // that are not restated (the FK, the cascade). Dropping NOT NULL is the
        // only change wanted here.
        DB::statement('ALTER TABLE attachments ALTER COLUMN uploader_id DROP NOT NULL');

        Schema::table('attachments', function (Blueprint $table) {
            $table->foreignUlid('public_chat_room_id')->nullable()
                ->constrained('public_chat_rooms')->nullOnDelete();
            $table->index(['public_chat_room_id'], 'attachments_public_chat_room_idx');
        });

        DB::statement('ALTER TABLE attachments
            ADD CONSTRAINT attachments_owner_chk
            CHECK (uploader_id IS NOT NULL OR public_chat_room_id IS NOT NULL)
            NOT VALID');
        DB::statement('ALTER TABLE attachments VALIDATE CONSTRAINT attachments_owner_chk');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_owner_chk');

        Schema::table('attachments', function (Blueprint $table) {
            $table->dropIndex('attachments_public_chat_room_idx');
            $table->dropConstrainedForeignId('public_chat_room_id');
        });

        // Deliberately NOT destructive: if visitor-owned rows exist this fails
        // loudly rather than deleting a customer's files to make the rollback fit.
        DB::statement('ALTER TABLE attachments ALTER COLUMN uploader_id SET NOT NULL');
    }
};
