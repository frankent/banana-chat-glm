<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Models\ChatSession;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class ChatSessionResource extends BrowseResource
{
    protected static ?string $model = ChatSession::class;

    protected static ?string $navigationIcon = 'heroicon-o-key';

    protected static ?string $navigationGroup = 'People & access';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('user.username')->searchable(), TextColumn::make('device.device_name')->placeholder('Unknown device'), TextColumn::make('ip'), TextColumn::make('last_used_at')->dateTime()->sortable(), TextColumn::make('expires_at')->dateTime(), TextColumn::make('revoked_at')->dateTime()->placeholder('Active'),
        ])->filters([SelectFilter::make('user_id')->relationship('user', 'username')->searchable()])->actions([
            Action::make('revoke')->requiresConfirmation()->color('danger')->visible(fn (ChatSession $r) => $r->isActive())->action(fn (ChatSession $record) => app(ModerationService::class)->revokeSession(auth('admin')->user(), $record)),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => ChatSessionResource\Pages\ListChatSession::route('/')];
    }
}
