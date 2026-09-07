<?php

namespace App\Domain\Ai;

use Illuminate\Support\Facades\Redis;

/**
 * NFR-OPS-011 — provider circuit breaker.
 *
 * 20 consecutive provider failures (AI_PROVIDER_ERROR / AI_PROVIDER_TIMEOUT)
 * open the circuit for 60s; while open the send endpoint answers
 * 503 AI_PROVIDER_ERROR immediately instead of queueing doomed jobs.
 * A successful generation resets the counter. Context-overflow and
 * cancellation never count — they are not provider health signals.
 */
class AiCircuitBreaker
{
    private const FAILURES = 'ai:breaker:failures';

    private const OPENED_AT = 'ai:breaker:opened_at';

    public function __construct(
        private readonly int $threshold,
        private readonly int $openSeconds,
    ) {}

    public static function make(): self
    {
        return new self(
            (int) config('ai.breaker.threshold', 20),
            (int) config('ai.breaker.open_seconds', 60),
        );
    }

    public function isOpen(): bool
    {
        return (bool) Redis::exists(self::OPENED_AT);
    }

    /** Seconds until the circuit half-opens again (0 = not open). */
    public function openRemaining(): int
    {
        return (int) Redis::ttl(self::OPENED_AT);
    }

    /**
     * @param  list<string>  $errorCodes  provider failure codes to count
     */
    public function recordFailure(string $errorCode): void
    {
        if (! in_array($errorCode, ['AI_PROVIDER_ERROR', 'AI_PROVIDER_TIMEOUT'], true)) {
            return;
        }

        $failures = Redis::incr(self::FAILURES);
        Redis::expire(self::FAILURES, max(300, $this->openSeconds * 5)); // stale counter self-clears

        if ($failures >= $this->threshold) {
            Redis::set(self::OPENED_AT, now()->getTimestamp(), 'EX', $this->openSeconds);
            Redis::del(self::FAILURES);
        }
    }

    public function recordSuccess(): void
    {
        Redis::del(self::FAILURES);
    }

    /** Test/ops helper — close the circuit manually. */
    public function reset(): void
    {
        Redis::del(self::FAILURES, self::OPENED_AT);
    }
}
