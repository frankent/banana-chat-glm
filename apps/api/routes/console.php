<?php

use App\Jobs\ExpireSecretRooms;
use App\Jobs\NotifyDueTickets;
use App\Jobs\PurgeDeletedAiConversations;
use App\Jobs\PurgeExpiredUploads;
use App\Jobs\PurgeRotatedRefreshTokens;
use App\Jobs\ReconcileCalls;
use App\Jobs\ReconcileMeetings;
use App\Jobs\RollupAiUsage;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// §4.3 AI retention — 03:15 daily; also sweeps stale ai:gen:* buffers
Schedule::job(new PurgeDeletedAiConversations)->dailyAt('03:15')->onOneServer();

// §4.3 — daily usage → monthly rollup + ws token budget check (FR-AI-010)
Schedule::job(new RollupAiUsage)->dailyAt('00:10')->onOneServer();

// FR-MEDIA-001 — pending uploads expire after 1h (TC-MEDIA-011), AND
// DEC-073 / FR-PCHAT-020 — completed-but-unreferenced PUBLIC CHAT attachments
// older than PurgeExpiredUploads::PUBLIC_CHAT_ORPHAN_GRACE_HOURS. The second
// sweep rides the same hourly job on purpose: it is the same table, the same
// disk handle and the same "reclaim what nothing points at" responsibility, and
// a separate schedule entry would be one more thing to forget to register. The
// grace period, not the tick rate, is what bounds how long an orphan lives.
Schedule::job(new PurgeExpiredUploads)->hourly()->onOneServer();

// R6 (REVIEW.md 2026-09-19) — bounded cleanup for the refresh-token reuse
// lineage; a row only needs to outlive replays within the token's own TTL.
Schedule::job(new PurgeRotatedRefreshTokens)->dailyAt('03:20')->onOneServer();

// NFR-OPS-011 — provider error-rate / first-token p95 alert rules (TASK-INF-014)
Schedule::command('ai:check-alerts')->everyFiveMinutes()->onOneServer();

// TASK-BE-041 / FR-KAN-004 — durable reminders, one scheduler owner.
Schedule::job(new NotifyDueTickets)->everyMinute()->onOneServer()->withoutOverlapping();

// FR-CALL-004: membership/session revocation is independent of browser cooperation.
Schedule::call(fn () => app()->call([new ReconcileCalls, 'handle']))->name('calls:reconcile')->everyTenSeconds()->onOneServer()->withoutOverlapping();

// FR-MEET-004: public meeting expiry and guest/member revocation.
Schedule::call(fn () => app()->call([new ReconcileMeetings, 'handle']))->name('meetings:reconcile')->everyTenSeconds()->onOneServer()->withoutOverlapping();

// FR-ROOM-012 / DEC-056 — purge expired secret rooms (access already denies
// at secret_expires_at; this reclaims rows, messages and upload objects).
Schedule::job(new ExpireSecretRooms)->everyMinute()->onOneServer()->withoutOverlapping();
