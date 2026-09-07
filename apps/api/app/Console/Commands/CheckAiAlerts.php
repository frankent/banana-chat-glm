<?php

namespace App\Console\Commands;

use App\Models\AiMessage;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * NFR-OPS-011 / TASK-INF-014 — AI health alerts, scheduled every 5 min:
 * - provider error rate > 10% over the last 5 min (≥10 attempts), and
 * - first-token p95 > 15s.
 * Alerts are structured warnings on the default channel — ops routes them
 * to Sentry/Slack once credentials are configured (see infra/README).
 */
class CheckAiAlerts extends Command
{
    protected $signature = 'ai:check-alerts {--window= : override window minutes}';

    protected $description = 'Evaluate NFR-OPS-011 AI alert rules over the recent window';

    public function handle(): int
    {
        $windowMinutes = (int) ($this->option('window') ?: config('ai.alerts.error_rate_window_minutes', 5));
        $since = now()->subMinutes($windowMinutes);
        $threshold = (float) config('ai.alerts.error_rate_threshold', 0.10);
        $minAttempts = (int) config('ai.alerts.min_attempts', 10);

        $terminal = ['completed', 'failed'];
        $attempts = AiMessage::query()
            ->where('role', 'assistant')
            ->whereIn('status', $terminal)
            ->where('updated_at', '>=', $since)
            ->count();
        $failed = AiMessage::query()
            ->where('role', 'assistant')
            ->where('status', 'failed')
            ->where('updated_at', '>=', $since)
            ->count();

        if ($attempts >= $minAttempts && ($failed / $attempts) > $threshold) {
            $this->alert("AI provider error rate {$failed}/{$attempts} over {$windowMinutes}m exceeds ".round($threshold * 100).'%');
            Log::warning('ai.provider_error_rate_alert', [
                'rule' => 'NFR-OPS-011',
                'failed' => $failed,
                'attempts' => $attempts,
                'window_minutes' => $windowMinutes,
            ]);
        }

        $p95 = (int) AiMessage::query()
            ->where('role', 'assistant')
            ->where('status', 'completed')
            ->whereNotNull('latency_first_token_ms')
            ->where('updated_at', '>=', $since)
            ->selectRaw('coalesce(percentile_cont(0.95) within group (order by latency_first_token_ms), 0) as p95')
            ->value('p95');

        if ($p95 > (int) config('ai.alerts.first_token_p95_ms', 15000)) {
            $this->alert("AI first-token p95 {$p95}ms exceeds ".config('ai.alerts.first_token_p95_ms').'ms');
            Log::warning('ai.first_token_p95_alert', [
                'rule' => 'NFR-OPS-011',
                'p95_ms' => $p95,
                'window_minutes' => $windowMinutes,
            ]);
        }

        return self::SUCCESS;
    }
}
