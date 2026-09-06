<?php

namespace App\Enums;

enum WorkspaceStatus: string
{
    case Active = 'active';
    case Archived = 'archived';
}
