<?php

namespace App\Enums;

/**
 * FR-PCHAT-002/009 — public_chat_messages.system_event.
 *
 * System rows carry `system_event` + `system_meta` and a NULL body on purpose,
 * so each serializer renders the sentence in the READER's locale. Baking a Thai
 * string into `body` would be unreadable to an 'en' visitor, and vice versa
 * (FR-I18N-001).
 */
enum PublicChatSystemEvent: string
{
    case Claimed = 'claimed';
    case Reassigned = 'reassigned';
    case StatusChanged = 'status_changed';
    case ClosedByCustomer = 'closed_by_customer';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
