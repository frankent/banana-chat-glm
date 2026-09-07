<?php

namespace App\Jobs;

use App\Models\Workspace;
use App\Services\AuditLogger;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * §4.3 `RollupAiUsage` (closes DEC-040) — daily 00:10:
 * 1. aggregate ai_usage_daily → ai_usage_monthly per (user, workspace, month)
 *    (idempotent upsert over every month that has daily rows — small data,
 *    and it self-heals backfills/late writes);
 * 2. FR-AI-010 ws token budget check — workspaces.settings.
 *    ai_monthly_token_budget: ≥80% → `ai.token_budget_warning` audit row
 *    (deduped once per workspace+month), ≥100% → Log::warning for ops +
 *    `ai.token_budget_exceeded` audit row.
 */
class RollupAiUsage implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function handle(): void
    {
        $this->rollupMonths();
        $this->checkWorkspaceBudgets();
    }

    private function rollupMonths(): void
    {
        DB::statement(<<<'SQL'
            INSERT INTO ai_usage_monthly (user_id, workspace_id, month, messages, tokens_in, tokens_out, tokens_memory, failed, rolled_up_at)
            SELECT user_id, workspace_id, date_trunc('month', date)::date AS month,
                   SUM(messages)::int, SUM(tokens_in)::bigint, SUM(tokens_out)::bigint, SUM(tokens_memory)::bigint, SUM(failed)::int,
                   now()
            FROM ai_usage_daily
            GROUP BY user_id, workspace_id, date_trunc('month', date)::date
            ON CONFLICT (user_id, COALESCE(workspace_id, '00000000000000000000000000'), month)
            DO UPDATE SET
                messages = EXCLUDED.messages,
                tokens_in = EXCLUDED.tokens_in,
                tokens_out = EXCLUDED.tokens_out,
                tokens_memory = EXCLUDED.tokens_memory,
                failed = EXCLUDED.failed,
                rolled_up_at = now()
        SQL);
    }

    private function checkWorkspaceBudgets(): void
    {
        $monthStart = now()->startOfMonth()->toDateString();

        $budgeted = Workspace::query()
            ->whereNotNull('settings')
            ->get()
            ->filter(fn (Workspace $ws) => (int) ($ws->settings['ai_monthly_token_budget'] ?? 0) > 0);

        foreach ($budgeted as $ws) {
            $budget = (int) $ws->settings['ai_monthly_token_budget'];
            // live daily rows for the running month — the monthly rollup only
            // catches up at the next 00:10 run and would lag today's spend
            $used = (int) DB::table('ai_usage_daily')
                ->where('workspace_id', $ws->id)
                ->where('date', '>=', $monthStart)
                ->sum(DB::raw('tokens_in + tokens_out + tokens_memory'));
            $ratio = $used / $budget;

            if ($ratio < 0.8) {
                continue;
            }

            $exceeded = $ratio >= 1.0;
            $action = $exceeded ? 'ai.token_budget_exceeded' : 'ai.token_budget_warning';
            $already = DB::table('audit_logs')
                ->where('action', $action)
                ->where('workspace_id', $ws->id)
                ->where('created_at', '>=', $monthStart)
                ->exists();
            if ($already) {
                continue; // one audit row per workspace+month+bucket
            }

            app(AuditLogger::class)->system($action, $ws->id, 'workspace', $ws->id, [
                'month' => $monthStart,
                'used_tokens' => $used,
                'budget' => $budget,
                'ratio' => round($ratio, 3),
            ]);

            if ($exceeded) {
                Log::warning('ai.token_budget_exceeded', [
                    'workspace_id' => $ws->id,
                    'used_tokens' => $used,
                    'budget' => $budget,
                    'rule' => 'FR-AI-010',
                ]);
            }
        }
    }
}
