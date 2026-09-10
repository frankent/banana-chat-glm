<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Models\RoomNote;
use App\Models\Workspace;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class RoomNoteResource extends BrowseResource
{
    protected static ?string $model = RoomNote::class;

    protected static ?string $navigationIcon = 'heroicon-o-document-text';

    protected static ?string $navigationGroup = 'Content';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('body')->searchable()->limit(80), TextColumn::make('author.display_name'), TextColumn::make('room_id')->label('Room')->limit(12), TextColumn::make('created_at')->dateTime(),
        ])->filters([SelectFilter::make('workspace_id')->label('Workspace')->options(fn () => Workspace::pluck('name', 'id'))])->actions([
            Action::make('inspect')->label('View')->modalContent(function (RoomNote $record) {
                app(ModerationService::class)->audit(auth('admin')->user(), 'room.note_viewed_admin', $record);

                return view('filament.admin.note', ['note' => $record->load('attachments')]);
            })->modalSubmitAction(false),
            Action::make('deleteNote')->label('Delete')->requiresConfirmation()->color('danger')->action(fn (RoomNote $record) => app(ModerationService::class)->deleteNote(auth('admin')->user(), $record)),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => RoomNoteResource\Pages\ListRoomNote::route('/')];
    }
}
