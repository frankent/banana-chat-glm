<?php

namespace App\Enums;

enum NotificationMode: string
{
    case All = 'all';
    case Mentions = 'mentions';
    case None = 'none';
}
