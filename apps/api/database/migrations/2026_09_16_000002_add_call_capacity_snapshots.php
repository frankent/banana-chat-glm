<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * FR-CALL-006 / DEC-057 — persisted capacity snapshot per call / meeting link.
 *
 * LiveKit CreateRoom does NOT update max_participants of an existing room
 * (verified against the deployed SFU: requested 5, actual stayed 2), so the
 * admin setting can only apply to rooms created after a change. Each call and
 * meeting link therefore stores the capacity it was created with; existing
 * rows keep the previous fixed cap of 8. Direct-room calls are always 2 and
 * never read the setting.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('room_calls', function (Blueprint $t) {
            $t->unsignedSmallInteger('capacity')->default(8)->after('kind');
        });
        DB::table('room_calls')->whereIn('room_id', fn ($q) => $q->select('id')->from('rooms')->where('type', 'dm'))->update(['capacity' => 2]);
        Schema::table('meetings', function (Blueprint $t) {
            $t->unsignedSmallInteger('capacity')->default(8)->after('title');
        });
    }

    public function down(): void
    {
        Schema::table('meetings', function (Blueprint $t) {
            $t->dropColumn('capacity');
        });
        Schema::table('room_calls', function (Blueprint $t) {
            $t->dropColumn('capacity');
        });
    }
};
