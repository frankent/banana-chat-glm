<?php

namespace App\Domain\Message;

use Illuminate\Support\Facades\DB;

/**
 * FR-MSG-012 — read side of message_reactions. One grouped query per page,
 * never per row. Order is count DESC, emoji ASC by UTF-8 bytes (= code point
 * order) so chips never reshuffle between REST, events and clients.
 */
class MessageReactions
{
    /**
     * @param  iterable<string>  $messageIds
     * @return array<string, array{reactions: list<array{emoji: string, count: int}>, my_reaction: ?string}>
     */
    public static function overlay(iterable $messageIds, ?string $viewerId): array
    {
        $ids = [];
        foreach ($messageIds as $id) {
            $ids[$id] = ['reactions' => [], 'my_reaction' => null];
        }
        if ($ids === []) {
            return [];
        }

        $keys = array_keys($ids);
        $rows = DB::table('message_reactions')
            ->whereIn('message_id', $keys)
            ->select('message_id', 'emoji', DB::raw('count(*) as c'))
            ->groupBy('message_id', 'emoji')
            ->get();
        foreach ($rows as $row) {
            $ids[$row->message_id]['reactions'][] = ['emoji' => $row->emoji, 'count' => (int) $row->c];
        }
        foreach ($ids as &$entry) {
            $entry['reactions'] = self::sort($entry['reactions']);
        }
        unset($entry);

        if ($viewerId !== null) {
            $mine = DB::table('message_reactions')
                ->whereIn('message_id', $keys)
                ->where('user_id', $viewerId)
                ->orderBy('emoji')
                ->pluck('emoji', 'message_id');
            foreach ($mine as $messageId => $emoji) {
                $ids[$messageId]['my_reaction'] = $emoji;
            }
        }

        return $ids;
    }

    /**
     * @return array{reactions: list<array{emoji: string, count: int}>, my_reaction: ?string}
     */
    public static function forMessage(string $messageId, ?string $viewerId): array
    {
        return self::overlay([$messageId], $viewerId)[$messageId];
    }

    /**
     * @param  list<array{emoji: string, count: int}>  $reactions
     * @return list<array{emoji: string, count: int}>
     */
    public static function sort(array $reactions): array
    {
        usort($reactions, fn (array $a, array $b) => $b['count'] <=> $a['count'] ?: strcmp($a['emoji'], $b['emoji']));

        return array_values($reactions);
    }
}
