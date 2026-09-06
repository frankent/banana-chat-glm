<?php

namespace App\Enums;

enum AttachmentStatus: string
{
    case Pending = 'pending';
    case Uploaded = 'uploaded';
    case Processing = 'processing';
    case Ready = 'ready';
    case Failed = 'failed';
    case Deleted = 'deleted';
}
