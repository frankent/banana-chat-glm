<?php

namespace App\Support;

/**
 * FR-MSG-012 / DEC-098 — what may be stored in message_reactions.emoji.
 *
 * Exactly ONE grapheme cluster that is a well-formed emoji: a flag
 * (regional-indicator pair), a keycap, a tag flag (🏴 + tag letters + cancel
 * tag), or pictographs joined by ZWJ where each carries at most one of FE0F or
 * a skin tone. A bare `\X` is not enough — "👍" + ZWJ / a combining mark / a
 * stray tag is still one cluster but would render as a look-alike second chip.
 * Anchored with \A…\z — `$` would accept a trailing "\n".
 * Stored value is canonical so "❤" and "❤️" can never become two chips.
 */
final class ReactionEmoji
{
    public const MAX_CHARS = 32;

    private const PICTOGRAPH_SEQUENCE = '/\A\p{Extended_Pictographic}(?:\x{FE0F}|[\x{1F3FB}-\x{1F3FF}])?'
        .'(?:\x{200D}\p{Extended_Pictographic}(?:\x{FE0F}|[\x{1F3FB}-\x{1F3FF}])?)*\z/u';

    public static function normalize(mixed $input): ?string
    {
        if (! is_string($input) || $input === '' || ! mb_check_encoding($input, 'UTF-8')) {
            return null;
        }
        if (mb_strlen($input) > self::MAX_CHARS || preg_match('/\A\X\z/u', $input) !== 1) {
            return null;
        }

        if (preg_match('/\A[\x{1F1E6}-\x{1F1FF}]{2}\z/u', $input) === 1) {
            return $input;
        }

        if (preg_match('/\A([0-9#*])\x{FE0F}?\x{20E3}\z/u', $input, $m) === 1) {
            return $m[1]."\u{FE0F}\u{20E3}";
        }

        $isTagFlag = preg_match('/\A\x{1F3F4}[\x{E0030}-\x{E0039}\x{E0061}-\x{E007A}]+\x{E007F}\z/u', $input) === 1;
        if (! $isTagFlag && preg_match(self::PICTOGRAPH_SEQUENCE, $input) !== 1) {
            return null;
        }

        // A lone BMP symbol (❤ ☀ ✔ …) is text-presentation by default; force emoji presentation.
        if (mb_strlen($input) === 1 && mb_ord($input) < 0x1F000) {
            return $input."\u{FE0F}";
        }

        return $input;
    }
}
