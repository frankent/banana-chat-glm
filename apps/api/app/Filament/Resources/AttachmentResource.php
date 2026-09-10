<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Enums\AttachmentStatus;
use App\Jobs\ProcessAttachment;
use App\Models\Attachment;
use App\Models\Workspace;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class AttachmentResource extends BrowseResource
{
    protected static ?string $model = Attachment::class;

    protected static ?string $navigationIcon = 'heroicon-o-photo';

    protected static ?string $navigationGroup = 'Content';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('original_name')->searchable()->limit(48), TextColumn::make('workspace_id')->label('Workspace')->formatStateUsing(fn ($state) => Workspace::find($state)?->name ?? $state),
            TextColumn::make('kind')->badge(), TextColumn::make('status')->badge(), TextColumn::make('size_bytes')->sortable()->formatStateUsing(fn ($state) => number_format($state / 1048576, 2).' MB'), TextColumn::make('mime_type'), TextColumn::make('scan_result')->placeholder('—'), TextColumn::make('created_at')->dateTime(),
        ])->filters([SelectFilter::make('workspace_id')->label('Workspace')->options(fn () => Workspace::pluck('name', 'id')), SelectFilter::make('status')->options(['pending' => 'Pending', 'uploaded' => 'Uploaded', 'processing' => 'Processing', 'ready' => 'Ready', 'failed' => 'Failed']), SelectFilter::make('kind')->options(['image' => 'Image', 'video' => 'Video', 'file' => 'File', 'avatar' => 'Avatar'])])->actions([
            Action::make('retry')->label('Retry processing')->requiresConfirmation()->visible(fn (Attachment $r) => $r->status === AttachmentStatus::Failed && ! $r->deleted_at && $r->scan_result !== 'infected')->action(function (Attachment $record) {
                app(ModerationService::class)->authorize(auth('admin')->user());
                $changed = Attachment::whereKey($record->id)->where('status', 'failed')->whereNull('deleted_at')->update(['status' => 'uploaded']);
                if ($changed) {
                    ProcessAttachment::dispatch($record->refresh());
                    app(ModerationService::class)->audit(auth('admin')->user(), 'attachment.retry_admin', $record);
                }
            }),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => AttachmentResource\Pages\ListAttachment::route('/')];
    }
}
