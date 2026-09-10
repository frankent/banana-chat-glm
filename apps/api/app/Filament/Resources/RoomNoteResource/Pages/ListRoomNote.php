<?php

namespace App\Filament\Resources\RoomNoteResource\Pages;

use App\Filament\Resources\RoomNoteResource;
use App\Services\AuditLogger;
use Filament\Resources\Pages\ListRecords;

class ListRoomNote extends ListRecords
{
    protected static string $resource = RoomNoteResource::class;

    public function mount(): void
    {
        parent::mount();
        app(AuditLogger::class)->log('roomnote.list_viewed_admin', auth('admin')->user());
    }
}
