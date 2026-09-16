<?php

namespace App\Enums;

/**
 * FR-PCHAT-002 — public_chat_messages.type.
 *
 * Deliberately NOT App\Enums\MessageType: no call/meet types exist in this
 * bounded context and none ever should. "No calls, no meetings" is structural
 * here (CallService::allowed() joins `rooms`, which a public chat room id does
 * not resolve against), and this enum is the type-level echo of that.
 */
enum PublicChatMessageType: string
{
    case Text = 'text';
    case Image = 'image';
    case Video = 'video';
    case File = 'file';
    case System = 'system';

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
