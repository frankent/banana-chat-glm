<?php

namespace App\Filament\Resources;

use Filament\Resources\Resource;

/** FR-ADM-007/012: browse and explicit actions only; no accidental raw CRUD. */
abstract class BrowseResource extends Resource
{
    public static function canCreate(): bool
    {
        return false;
    }

    public static function canEdit($record): bool
    {
        return false;
    }

    public static function canDelete($record): bool
    {
        return false;
    }

    public static function canDeleteAny(): bool
    {
        return false;
    }
}
