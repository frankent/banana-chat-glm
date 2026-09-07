<?php

use App\Jobs\RollupAiUsage;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/**
 * §4.3 RollupAiUsage (closes DEC-040) — daily→monthly aggregation + FR-AI-010
 * ws token budget alerts (TC-AI-122..124).
 */
beforeEach(function () {
    $this->tony = User::factory()->create();
    $this->anna = User::factory()->create();
    $this->ws = Workspace::factory()->create();
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
});

function dailyRow(string $userId, ?string $workspaceId, string $date, array $counts): void
{
    DB::table('ai_usage_daily')->insert(array_merge([
        'user_id' => $userId,
        'workspace_id' => $workspaceId,
        'date' => $date,
    ], $counts));
}

test('TC-AI-122 daily rows aggregate into monthly sums per user/workspace/month', function () {
    $m = today()->startOfMonth()->toDateString();
    dailyRow($this->tony->id, $this->ws->id, $m, ['messages' => 10, 'tokens_in' => 100, 'tokens_out' => 50, 'tokens_memory' => 5, 'failed' => 1]);
    dailyRow($this->tony->id, $this->ws->id, today()->toDateString(), ['messages' => 7, 'tokens_in' => 70, 'tokens_out' => 30, 'tokens_memory' => 5, 'failed' => 0]);
    dailyRow($this->tony->id, null, today()->toDateString(), ['messages' => 3, 'tokens_in' => 30, 'tokens_out' => 20, 'tokens_memory' => 0, 'failed' => 0]);
    // previous month rolls into its own row
    dailyRow($this->anna->id, $this->ws->id, today()->subMonth()->startOfMonth()->toDateString(), ['messages' => 1, 'tokens_in' => 1, 'tokens_out' => 1, 'tokens_memory' => 1, 'failed' => 1]);

    (new RollupAiUsage)->handle();

    $rows = DB::table('ai_usage_monthly')->orderBy('user_id')->orderBy('workspace_id')->get();
    expect($rows)->toHaveCount(3);

    $wsRow = $rows->firstWhere('user_id', $this->tony->id);
    expect((int) $wsRow->messages)->toBe(17)
        ->and((int) $wsRow->tokens_in)->toBe(170)
        ->and((int) $wsRow->tokens_out)->toBe(80)
        ->and((int) $wsRow->tokens_memory)->toBe(10)
        ->and((int) $wsRow->failed)->toBe(1)
        ->and($wsRow->month)->toBe($m)
        ->and($wsRow->rolled_up_at)->not->toBeNull();

    // NULL workspace stays a separate group
    $personal = $rows->firstWhere('workspace_id', null);
    expect($personal)->not->toBeNull()
        ->and((int) $personal->messages)->toBe(3);

    $old = $rows->firstWhere('user_id', $this->anna->id);
    expect($old->month)->toBe(today()->subMonth()->startOfMonth()->toDateString());
});

test('TC-AI-123 rollup is idempotent — re-running never double counts', function () {
    dailyRow($this->tony->id, $this->ws->id, today()->toDateString(), ['messages' => 5, 'tokens_in' => 500, 'tokens_out' => 250, 'tokens_memory' => 0, 'failed' => 0]);

    (new RollupAiUsage)->handle();
    (new RollupAiUsage)->handle();

    expect(DB::table('ai_usage_monthly')->count())->toBe(1);
    $row = DB::table('ai_usage_monthly')->first();
    expect((int) $row->messages)->toBe(5)->and((int) $row->tokens_in)->toBe(500);
});

test('TC-AI-124 ws token budget: 80% warning and 100% exceeded audit rows, deduped per month', function () {
    config(['ai.retry_backoff' => false]);
    $budget = 1000;
    $this->ws->settings = ['ai_monthly_token_budget' => $budget];
    $this->ws->save();

    // 850/1000 = 85% → warning bucket
    dailyRow($this->tony->id, $this->ws->id, today()->toDateString(),
        ['messages' => 1, 'tokens_in' => 500, 'tokens_out' => 350, 'tokens_memory' => 0, 'failed' => 0]);

    (new RollupAiUsage)->handle();
    (new RollupAiUsage)->handle(); // dedupe: still one row

    expect(DB::table('audit_logs')->where('action', 'ai.token_budget_warning')->count())->toBe(1)
        ->and(DB::table('audit_logs')->where('action', 'ai.token_budget_exceeded')->count())->toBe(0);

    // cross 100% → exceeded row (warning row already there, stays 1)
    DB::table('ai_usage_daily')
        ->where('user_id', $this->tony->id)
        ->update(['tokens_out' => 600]);

    (new RollupAiUsage)->handle();

    expect(DB::table('audit_logs')->where('action', 'ai.token_budget_exceeded')->count())->toBe(1)
        ->and(DB::table('audit_logs')->where('action', 'ai.token_budget_warning')->count())->toBe(1);

    $ctx = json_decode(DB::table('audit_logs')->where('action', 'ai.token_budget_exceeded')->value('context'), true);
    expect($ctx['budget'])->toBe($budget)
        ->and($ctx['used_tokens'])->toBe(1100)
        ->and($ctx['ratio'])->toBe(1.1);
});

test('workspaces without a budget never produce audit rows', function () {
    dailyRow($this->tony->id, $this->ws->id, today()->toDateString(), ['messages' => 1, 'tokens_in' => 999999, 'tokens_out' => 0, 'tokens_memory' => 0, 'failed' => 0]);

    (new RollupAiUsage)->handle();

    expect(DB::table('audit_logs')->where('action', 'like', 'ai.token_budget%')->count())->toBe(0);
});
