<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

/**
 * §4.2 `ai_usage_daily` — PK is (user_id, workspace_id, date) in the spec;
 * workspace_id is nullable so uniqueness is enforced by an expression
 * index. Upserts go through raw SQL keyed on both columns.
 */
class AiUsageDaily extends Model
{
    protected $table = 'ai_usage_daily'; // avoid "dailies" pluralization

    public $timestamps = false;

    public $incrementing = false;

    protected $primaryKey = null; // composite via expression index

    protected $fillable = [
        'user_id', 'workspace_id', 'date', 'messages', 'tokens_in', 'tokens_out', 'tokens_memory', 'failed',
    ];

    protected function casts(): array
    {
        return [
            'date' => 'date',
            'messages' => 'integer',
            'tokens_in' => 'integer',
            'tokens_out' => 'integer',
            'tokens_memory' => 'integer',
            'failed' => 'integer',
        ];
    }

    /**
     * FR-AI-003/010 — bump today's usage counters for (user, workspace).
     */
    public static function bump(
        string $userId,
        ?string $workspaceId,
        int $messages = 0,
        int $tokensIn = 0,
        int $tokensOut = 0,
        int $tokensMemory = 0,
        int $failed = 0,
    ): void {
        DB::statement(<<<'SQL'
            INSERT INTO ai_usage_daily (user_id, workspace_id, date, messages, tokens_in, tokens_out, tokens_memory, failed)
            VALUES (?, ?, CURRENT_DATE, 0, 0, 0, 0, 0)
            ON CONFLICT DO NOTHING
        SQL, [$userId, $workspaceId]);

        DB::statement(<<<'SQL'
            UPDATE ai_usage_daily
            SET messages = messages + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
                tokens_memory = tokens_memory + ?, failed = failed + ?
            WHERE user_id = ? AND date = CURRENT_DATE
              AND COALESCE(workspace_id, '00000000000000000000000000') = COALESCE(?, '00000000000000000000000000')
        SQL, [$messages, $tokensIn, $tokensOut, $tokensMemory, $failed, $userId, $workspaceId]);
    }

    /**
     * FR-AI-010 — messages sent today in the user's timezone.
     */
    public static function messagesToday(string $userId, string $timezone): int
    {
        $row = DB::selectOne(
            'SELECT COALESCE(SUM(messages), 0) AS total FROM ai_usage_daily WHERE user_id = ? AND (timezone(?, now())::date) = date',
            [$userId, $timezone],
        );

        return (int) ($row->total ?? 0);
    }

    /**
     * FR-AI-010 — today's token totals for /ai/status.
     *
     * @return array{messages: int, tokens: int}
     */
    public static function today(string $userId, string $timezone): array
    {
        $row = DB::selectOne(
            'SELECT COALESCE(SUM(messages),0) AS messages, COALESCE(SUM(tokens_in + tokens_out + tokens_memory),0) AS tokens
             FROM ai_usage_daily WHERE user_id = ? AND date = (timezone(?, now())::date)',
            [$userId, $timezone],
        );

        return ['messages' => (int) $row->messages, 'tokens' => (int) $row->tokens];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
