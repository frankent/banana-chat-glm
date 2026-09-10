<?php

namespace App\Filament\Pages;

use App\Models\AiProvider;
use Carbon\CarbonImmutable;
use Filament\Pages\Page;
use Illuminate\Support\Facades\DB;

/**
 * FR-AI-014 — AI usage dashboard (admin). Numbers are aggregated live from
 * ai_usage_daily (TC-ADM-066: ตัวเลขตรง ai_usage_daily); the monthly table
 * stays a §4.3 rollup for history/budget, not the dashboard source.
 */
class AiUsage extends Page
{
    protected static ?string $navigationGroup = 'AI';

    protected static ?string $navigationIcon = 'heroicon-o-chart-bar';

    protected static ?string $navigationLabel = 'AI Usage';

    protected static ?string $title = 'AI Usage';

    protected static ?int $navigationSort = 4;

    protected static string $view = 'filament.pages.ai-usage';

    public ?string $month = null;

    public function mount(): void
    {
        $this->month = today()->format('Y-m');
    }

    private function monthStart(): CarbonImmutable
    {
        $parsed = CarbonImmutable::createFromFormat('Y-m', (string) $this->month);

        return $parsed !== false ? $parsed->startOfMonth() : today()->startOfMonth();
    }

    private function rangeSql(): array
    {
        $start = $this->monthStart();

        return [$start->toDateString(), $start->endOfMonth()->toDateString()];
    }

    /**
     * @return array<string, string>
     */
    public function monthOptions(): array
    {
        $months = DB::table('ai_usage_daily')
            ->selectRaw("DISTINCT to_char(date_trunc('month', date), 'YYYY-MM') AS m")
            ->orderByDesc('m')
            ->limit(24)
            ->pluck('m')
            ->all();
        if (! in_array(today()->format('Y-m'), $months, true)) {
            array_unshift($months, today()->format('Y-m'));
        }

        return array_combine($months, $months);
    }

    /**
     * @return array{messages: int, tokens_in: int, tokens_out: int, tokens_memory: int, failed: int}
     */
    public function summary(): array
    {
        [$from, $to] = $this->rangeSql();
        $row = DB::table('ai_usage_daily')
            ->whereBetween('date', [$from, $to])
            ->selectRaw('COALESCE(SUM(messages),0) AS messages, COALESCE(SUM(tokens_in),0) AS tokens_in,
                COALESCE(SUM(tokens_out),0) AS tokens_out, COALESCE(SUM(tokens_memory),0) AS tokens_memory,
                COALESCE(SUM(failed),0) AS failed')
            ->first();

        return [
            'messages' => (int) $row->messages,
            'tokens_in' => (int) $row->tokens_in,
            'tokens_out' => (int) $row->tokens_out,
            'tokens_memory' => (int) $row->tokens_memory,
            'failed' => (int) $row->failed,
        ];
    }

    /**
     * P1 — rough cost via the default provider's price_per_1k_in/out
     * (usage rows don't record which provider served them).
     */
    public function estimatedCost(): ?string
    {
        $provider = AiProvider::query()->where('is_default', true)->first();
        if ($provider === null || ($provider->price_per_1k_in === null && $provider->price_per_1k_out === null)) {
            return null;
        }
        $s = $this->summary();
        $cost = ($s['tokens_in'] / 1000) * (float) $provider->price_per_1k_in
            + ($s['tokens_out'] / 1000) * (float) $provider->price_per_1k_out;

        return '$'.number_format($cost, 2);
    }

    /**
     * @return array<int, array{label: string, messages: int, tokens: int}>
     */
    public function byWorkspace(): array
    {
        [$from, $to] = $this->rangeSql();

        return DB::table('ai_usage_daily')
            ->leftJoin('workspaces', 'workspaces.id', '=', 'ai_usage_daily.workspace_id')
            ->whereBetween('date', [$from, $to])
            ->groupBy('workspace_id', 'workspaces.name')
            ->orderByDesc('tokens')
            ->selectRaw("COALESCE(workspaces.name, '— ส่วนตัว (no workspace)') AS label,
                SUM(messages)::int AS messages, SUM(tokens_in + tokens_out + tokens_memory)::bigint AS tokens")
            ->get()
            ->map(fn ($r) => ['label' => $r->label, 'messages' => (int) $r->messages, 'tokens' => (int) $r->tokens])
            ->all();
    }

    /**
     * FR-AI-014 top 20 users by token spend.
     *
     * @return array<int, array{name: string, messages: int, tokens: int}>
     */
    public function topUsers(): array
    {
        [$from, $to] = $this->rangeSql();

        return DB::table('ai_usage_daily')
            ->join('users', 'users.id', '=', 'ai_usage_daily.user_id')
            ->whereBetween('date', [$from, $to])
            ->groupBy('users.id', 'users.display_name')
            ->orderByDesc('tokens')
            ->limit(20)
            ->selectRaw('users.display_name AS name, SUM(messages)::int AS messages,
                SUM(tokens_in + tokens_out + tokens_memory)::bigint AS tokens')
            ->get()
            ->map(fn ($r) => ['name' => $r->name, 'messages' => (int) $r->messages, 'tokens' => (int) $r->tokens])
            ->all();
    }

    /**
     * FR-AI-014 per-model health: error rate + first-token p50/p95
     * (ai_messages has no provider_id — grouped by model, matched to
     * provider names where possible).
     *
     * @return array<int, object>
     */
    public function providerHealth(): array
    {
        [$from, $to] = $this->rangeSql();

        return DB::table('ai_messages')
            ->where('role', 'assistant')
            ->whereIn('status', ['completed', 'failed'])
            ->whereBetween(DB::raw('created_at::date'), [$from, $to])
            ->groupBy('model')
            ->orderByDesc('attempts')
            ->selectRaw('model,
                COUNT(*)::int AS attempts,
                SUM(CASE WHEN status = \'failed\' THEN 1 ELSE 0 END)::int AS failed,
                COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_first_token_ms), 0)::int AS p50,
                COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_first_token_ms), 0)::int AS p95')
            ->get()
            ->all();
    }
}
