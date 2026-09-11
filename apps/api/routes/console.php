<?php

use App\Jobs\NotifyDueTickets;
use App\Jobs\PurgeDeletedAiConversations;
use App\Jobs\PurgeExpiredUploads;
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

// FR-MEDIA-001 — pending uploads expire after 1h (TC-MEDIA-011)
Schedule::job(new PurgeExpiredUploads)->hourly()->onOneServer();

// NFR-OPS-011 — provider error-rate / first-token p95 alert rules (TASK-INF-014)
Schedule::command('ai:check-alerts')->everyFiveMinutes()->onOneServer();

// TASK-BE-041 / FR-KAN-004 — durable reminders, one scheduler owner.
Schedule::job(new NotifyDueTickets)->everyMinute()->onOneServer()->withoutOverlapping();
