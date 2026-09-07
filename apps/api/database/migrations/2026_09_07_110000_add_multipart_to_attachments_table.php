<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * TASK-BE-024 / FR-MEDIA-001 — S3 multipart session for >50MB uploads.
 * Both null for the single-PUT flow (and every non-S3 disk).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('attachments', function (Blueprint $table) {
            $table->string('multipart_upload_id', 128)->nullable()->after('scan_result');
            $table->unsignedInteger('multipart_part_bytes')->nullable()->after('multipart_upload_id');
        });
    }

    public function down(): void
    {
        Schema::table('attachments', function (Blueprint $table) {
            $table->dropColumn(['multipart_upload_id', 'multipart_part_bytes']);
        });
    }
};
