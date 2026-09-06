<?php

namespace App\Enums;

enum AttachmentKind: string
{
    case Image = 'image';
    case Video = 'video';
    case File = 'file';
    case Avatar = 'avatar';
}
