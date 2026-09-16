<?php

namespace App\Filament\Resources\PublicChatRoomResource\Pages;

use App\Filament\Resources\PublicChatRoomResource;
use Filament\Resources\Pages\ListRecords;

/**
 * FR-PCHAT-021 — browse only. No header actions on purpose: public chat rooms
 * are created by the partner API (API-200), never by an admin.
 */
class ListPublicChatRooms extends ListRecords
{
    protected static string $resource = PublicChatRoomResource::class;
}
