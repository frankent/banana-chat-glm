<?php

namespace App\Jobs;

use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * R6 (REVIEW.md 2026-09-19) — bounded cleanup for refresh_token_lineage. A
 * consumed hash only needs to outlive replays within the refresh token's own
 * rolling window; past that, a session using that lineage is either revoked
 * or has long since rotated again, and the row is dead weight.
 */
class PurgeRotatedRefreshTokens implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public function handle(SettingsService $settings): void
    {
        $ttlDays = $settings->int('auth.refresh_token_ttl_days');

        $purged = DB::table('refresh_token_lineage')
            ->where('rotated_at', '<', now()->subDays($ttlDays))
            ->delete();

        if ($purged > 0) {
            Log::info('auth.refresh_token_lineage_purged', ['count' => $purged]);
        }
    }
}
