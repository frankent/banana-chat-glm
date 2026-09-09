<?php

namespace App\Filament\Resources\AiProviderResource\Pages;

use App\Filament\Resources\AiProviderResource;
use Filament\Actions;
use Filament\Resources\Pages\ListRecords;

class ListAiProviders extends ListRecords
{
    protected static string $resource = AiProviderResource::class;

    // Filament v4 ListRecords registers no default header actions — without
    // this the list renders with no create entry point (found on prod:
    // /admin/ai-providers showed an empty state and no button).
    protected function getHeaderActions(): array
    {
        return [
            Actions\CreateAction::make(),
        ];
    }
}
