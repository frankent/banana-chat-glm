<?php

namespace App\Domain\Ai;

/**
 * FR-AI-005 (DEC-018) — cheap token estimate used by the ContextBuilder.
 * Thai/CJK ≈ 1 token per 1.2 chars, everything else ≈ 1 per 3.5 chars,
 * with a 1.1 safety margin, scaled by the conversation's measured ratio
 * (EMA of provider usage.prompt_tokens / estimate).
 */
class TokenEstimator
{
    public const MARGIN = 1.1;

    public function estimate(string $text, ?float $ratio = null): int
    {
        if ($text === '') {
            return 0;
        }

        $thaiOrCjk = preg_match_all('/[\x{0E00}-\x{0E7F}\x{2E80}-\x{9FFF}\x{3040}-\x{30FF}\x{AC00}-\x{D7AF}]/u', $text);
        $dense = (int) ($thaiOrCjk === false ? 0 : $thaiOrCjk);
        $rest = max(0, mb_strlen($text) - $dense);

        $tokens = ceil($dense / 1.2) + ceil($rest / 3.5);
        $tokens *= self::MARGIN;

        if ($ratio !== null && $ratio > 0) {
            $tokens *= $ratio;
        }

        return (int) ceil($tokens);
    }

    /**
     * EMA update of the conversation's actual/estimate ratio (DEC-018).
     */
    public function nextRatio(?float $current, int $estimated, int $actualPromptTokens): ?float
    {
        if ($estimated <= 0 || $actualPromptTokens <= 0) {
            return $current;
        }

        $observed = $actualPromptTokens / $estimated;

        return $current === null
            ? round($observed, 3)
            : round(0.7 * $current + 0.3 * $observed, 3);
    }
}
