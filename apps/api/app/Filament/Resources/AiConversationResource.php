<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Models\AiConversation;
use App\Services\SettingsService;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class AiConversationResource extends BrowseResource
{
    protected static ?string $model = AiConversation::class;

    protected static ?string $navigationIcon = 'heroicon-o-sparkles';

    protected static ?string $navigationGroup = 'AI';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('id')->label('Conversation')->limit(16), TextColumn::make('user.username')->searchable(), TextColumn::make('message_count')->sortable(), TextColumn::make('total_tokens_in')->numeric(), TextColumn::make('total_tokens_out')->numeric(), TextColumn::make('last_message_at')->dateTime(), TextColumn::make('deleted_at')->dateTime()->placeholder('—'),
        ])->filters([SelectFilter::make('user_id')->relationship('user', 'username')->searchable()])->actions([
            Action::make('review')->visible(fn () => app(SettingsService::class)->bool('ai.admin_review_enabled'))->modalContent(function (AiConversation $record) {
                abort_unless(app(SettingsService::class)->bool('ai.admin_review_enabled'), 403);
                app(ModerationService::class)->audit(auth('admin')->user(), 'ai.conversation_reviewed', $record);

                return view('filament.admin.ai-review', ['messages' => $record->messages()->orderByDesc('seq')->limit(100)->get()->reverse()]);
            })->modalSubmitAction(false),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => AiConversationResource\Pages\ListAiConversation::route('/')];
    }
}
