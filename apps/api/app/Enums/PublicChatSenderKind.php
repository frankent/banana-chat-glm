<?php

namespace App\Enums;

/**
 * FR-PCHAT-002/014 — who wrote a public_chat_messages row.
 *
 * ALWAYS set server-side from the authenticated tier, NEVER from the request
 * payload: Tier 2 (visitor) has no code path that can write `agent`, which is
 * what makes visitor->agent impersonation structurally impossible.
 *
 * It is also the middle column of the idempotency unique
 * (room_id, sender_kind, client_message_id) — see DEC-066 / graft 13.
 */
enum PublicChatSenderKind: string
{
    case Visitor = 'visitor';
    case Agent = 'agent';
    case System = 'system';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
