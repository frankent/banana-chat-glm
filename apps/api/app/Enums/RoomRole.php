<?php

namespace App\Enums;

enum RoomRole: string
{
    case Owner = 'owner';
    case Admin = 'admin';
    case Member = 'member';

    public function atLeast(self $other): bool
    {
        return $this->rank() >= $other->rank();
    }

    public function rank(): int
    {
        return match ($this) {
            self::Member => 1,
            self::Admin => 2,
            self::Owner => 3,
        };
    }
}
