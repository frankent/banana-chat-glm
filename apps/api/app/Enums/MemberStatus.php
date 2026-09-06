<?php

namespace App\Enums;

enum MemberStatus: string
{
    case Active = 'active';
    case Removed = 'removed';
}
