<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * §4.3 `RollupAiUsage` target table (closes DEC-040) — monthly aggregation
 * of ai_usage_daily per (user, workspace). Same nullable-workspace trick as
 * the daily table: unique expression index instead of a composite PK.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ai_usage_monthly', function (Blueprint $table) {
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('workspace_id')->nullable()->constrained('workspaces')->nullOnDelete();
            $table->date('month'); // first day of the month
            $table->unsignedInteger('messages')->default(0);
            $table->unsignedBigInteger('tokens_in')->default(0);
            $table->unsignedBigInteger('tokens_out')->default(0);
            $table->unsignedBigInteger('tokens_memory')->default(0);
            $table->unsignedInteger('failed')->default(0);
            $table->timestampTz('rolled_up_at')->nullable();
        });
        DB::statement("CREATE UNIQUE INDEX ai_usage_monthly_unique_idx ON ai_usage_monthly (user_id, COALESCE(workspace_id, '00000000000000000000000000'), month)");
    }

    public function down(): void
    {
        Schema::dropIfExists('ai_usage_monthly');
    }
};
