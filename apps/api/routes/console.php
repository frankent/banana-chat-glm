<?php

use App\Jobs\PurgeDeletedAiConversations;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// §4.3 AI retention — 03:15 daily; also sweeps stale ai:gen:* buffers
Schedule::job(new PurgeDeletedAiConversations)->dailyAt('03:15')->onOneServer();

// NFR-OPS-011 — provider error-rate / first-token p95 alert rules (TASK-INF-014)
Schedule::command('ai:check-alerts')->everyFiveMinutes()->onOneServer();
