<?php

namespace App\Filament\Resources\UserResource\Pages;

use App\Filament\Resources\UserResource;
use Filament\Resources\Pages\ListRecords;

class ListUsers extends ListRecords
{
    protected static string $resource = UserResource::class;

    // No page-level CreateAction here on purpose: this resource has no
    // create page — creation is the table header action (createUser →
    // AdminUserService temp password). A page-level create raw-inserts
    // and 500s on the NOT NULL password_hash (found on prod).
}
