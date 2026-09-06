<?php

namespace App\Enums;

enum MessageDeleteReason: string
{
    case Sender = 'sender';
    case Moderator = 'moderator';
    case Retention = 'retention';
}
