<?php

namespace App\Enums;

enum ActorType: string
{
    case User = 'user';
    case Admin = 'admin';
    case System = 'system';
}
