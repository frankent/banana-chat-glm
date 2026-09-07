<?php

namespace App\Domain\Message;

/**
 * FR-MSG-008 — pull @username tokens out of a message body.
 *
 * TC-MSG-049: matches `@tony`, `@a.b`; never the domain half of an email
 * (`kiat@gmail.com` — the @ is preceded by a word char). `@all` is reported
 * separately as the all-flag.
 */
class MentionParser
{
    private const TOKEN = '/(?<!\w)@([a-zA-Z0-9][a-zA-Z0-9_.]*)/';

    /**
     * @return array{0: list<string>, 1: bool} [unique usernames in order, has @all]
     */
    public function parse(string $body): array
    {
        preg_match_all(self::TOKEN, $body, $matches);

        $users = [];
        $all = false;

        foreach ($matches[1] as $username) {
            if (strtolower($username) === 'all') {
                $all = true;

                continue;
            }

            $users[strtolower($username)] = $username; // dedupe, keep first casing
        }

        return [array_values($users), $all];
    }
}
