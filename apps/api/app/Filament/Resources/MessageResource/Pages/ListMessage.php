<?php

namespace App\Filament\Resources\MessageResource\Pages;

use App\Filament\Resources\MessageResource;
use App\Services\AuditLogger;
use Filament\Resources\Pages\ListRecords;

class ListMessage extends ListRecords
{
    protected static string $resource = MessageResource::class;

    public function mount(): void
    {
        parent::mount();
        app(AuditLogger::class)->log('message.list_viewed_admin', auth('admin')->user());
    }
}
