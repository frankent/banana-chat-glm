<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Events\RoomToolEvent;
use App\Models\Message;
use App\Models\Room;
use App\Models\Workspace;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Support\Facades\DB;

class MessageResource extends BrowseResource
{
    protected static ?string $model = Message::class;

    protected static ?string $navigationIcon = 'heroicon-o-chat-bubble-bottom-center-text';

    protected static ?string $navigationGroup = 'Content';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('seq')->sortable(), TextColumn::make('room.name')->placeholder('Direct message'), TextColumn::make('sender.display_name')->placeholder('System / AI'),
            TextColumn::make('body')->searchable()->limit(80)->placeholder('Attachment / deleted'), TextColumn::make('type')->badge(),
            TextColumn::make('created_at')->dateTime()->sortable(), TextColumn::make('deleted_at')->dateTime()->placeholder('—'),
        ])->filters([SelectFilter::make('workspace_id')->label('Workspace')->options(fn () => Workspace::pluck('name', 'id')), SelectFilter::make('room_id')->label('Room')->options(fn () => Room::get()->mapWithKeys(fn ($r) => [$r->id => $r->name ?? 'DM '.$r->id]))->searchable()])->actions([
            Action::make('inspect')->label('View / history')->modalContent(function (Message $record) {
                app(ModerationService::class)->audit(auth('admin')->user(), 'message.viewed_admin', $record);

                return view('filament.admin.message', ['message' => $record->load('edits', 'attachments')]);
            })->modalSubmitAction(false)->modalWidth('4xl'),
            Action::make('deleteMessage')->label('Delete')->requiresConfirmation()->color('danger')->visible(fn (Message $r) => ! $r->deleted_at)->action(fn (Message $record) => app(ModerationService::class)->deleteMessage(auth('admin')->user(), $record)),
            Action::make('unpin')->visible(fn (Message $r) => DB::table('room_pins')->where('message_id', $r->id)->exists())->requiresConfirmation()->action(function (Message $record) {
                DB::table('room_pins')->where('message_id', $record->id)->delete();
                app(ModerationService::class)->audit(auth('admin')->user(), 'room.message_unpinned_admin', $record);
                broadcast(new RoomToolEvent($record->room, 'room.pins_changed'));
            }),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => MessageResource\Pages\ListMessage::route('/')];
    }
}
