<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * FR-MEDIA-006 — virus-scan outcome per attachment
 * (clean / infected / skipped-when-clamd-down, TC-MEDIA-034 flag).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('attachments', function (Blueprint $table) {
            $table->string('scan_result', 16)->nullable()->after('checksum_sha256');
        });
    }

    public function down(): void
    {
        Schema::table('attachments', function (Blueprint $table) {
            $table->dropColumn('scan_result');
        });
    }
};
