<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A DM key is unique per workspace, not globally: the same pair of people can
 * share several workspaces and each needs its own DM. No data rewrite — every
 * lookup is already workspace-scoped, so existing keys stay valid.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('rooms', function (Blueprint $table) {
            $table->dropUnique('rooms_dm_key_unique');
            $table->unique(['workspace_id', 'dm_key'], 'rooms_workspace_dm_key_unique');
        });
    }

    public function down(): void
    {
        // Can fail if the same dm_key now exists in more than one workspace.
        Schema::table('rooms', function (Blueprint $table) {
            $table->dropUnique('rooms_workspace_dm_key_unique');
            $table->unique('dm_key', 'rooms_dm_key_unique');
        });
    }
};
