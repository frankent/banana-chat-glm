<?php

namespace App\Filament\Resources;

use App\Enums\WorkspaceStatus;
use App\Filament\Resources\WorkspaceResource\Pages;
use App\Filament\Resources\WorkspaceResource\RelationManagers;
use App\Models\Workspace;
use App\Services\AuditLogger;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Form;
use Filament\Resources\Resource;
use Filament\Tables\Actions\Action;
use Filament\Tables\Actions\EditAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

/**
 * FR-ADM-005 — workspace CRUD, archive/unarchive, retention (TASK-ADM-005).
 */
class WorkspaceResource extends Resource
{
    protected static ?string $navigationGroup = 'People & access';

    protected static ?string $model = Workspace::class;

    protected static ?string $navigationIcon = 'heroicon-o-building-office-2';

    protected static ?int $navigationSort = 2;

    public static function canDelete($record): bool
    {
        return false;
    }

    public static function canDeleteAny(): bool
    {
        return false;
    }

    public static function form(Form $form): Form
    {
        return $form
            ->schema([
                TextInput::make('name')
                    ->required()
                    ->maxLength(100),
                TextInput::make('slug')
                    ->required()
                    ->maxLength(50)
                    ->unique(ignoreRecord: true)
                    ->regex('/^[a-z0-9][a-z0-9-]*$/')
                    ->helperText('ตัวพิมพ์เล็ก ตัวเลข ขีดกลาง'),
                TextInput::make('message_retention_days')
                    ->numeric()
                    ->minValue(30)
                    ->nullable()
                    ->helperText('ว่าง = เก็บตาม default (ถาวร)'),
                TextInput::make('attachment_retention_days')
                    ->numeric()
                    ->minValue(30)
                    ->nullable(),
            ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')
                    ->searchable()
                    ->sortable(),
                TextColumn::make('slug')
                    ->searchable(),
                TextColumn::make('status')
                    ->badge()
                    ->formatStateUsing(fn ($state): string => $state instanceof WorkspaceStatus ? $state->value : (string) $state)
                    ->color(fn ($state): string => ($state instanceof WorkspaceStatus ? $state->value : (string) $state) === 'active' ? 'success' : 'gray'),
                TextColumn::make('members_count')
                    ->counts('members')
                    ->label('สมาชิก'),
                TextColumn::make('message_retention_days')
                    ->placeholder('∞'),
                TextColumn::make('created_at')
                    ->dateTime('Y-m-d')
                    ->sortable(),
            ])
            ->filters([
                SelectFilter::make('status')
                    ->options(['active' => 'Active', 'archived' => 'Archived']),
            ])
            ->actions([
                EditAction::make(),

                Action::make('archive')
                    ->label('Archive')
                    ->icon('heroicon-o-archive-box')
                    ->color('warning')
                    ->requiresConfirmation()
                    ->visible(fn (Workspace $record): bool => $record->status === WorkspaceStatus::Active)
                    ->action(function (Workspace $record): void {
                        $record->update(['status' => 'archived']);
                        app(AuditLogger::class)->log('workspace.archived', auth('admin')->user(), 'workspace', $record->id);
                    }),
                Action::make('unarchive')
                    ->label('Unarchive')
                    ->icon('heroicon-o-archive-box-arrow-down')
                    ->color('success')
                    ->visible(fn (Workspace $record): bool => $record->status === WorkspaceStatus::Archived)
                    ->action(function (Workspace $record): void {
                        $record->update(['status' => 'active']);
                        app(AuditLogger::class)->log('workspace.unarchived', auth('admin')->user(), 'workspace', $record->id);
                    }),
            ])
            ->bulkActions([]);
    }

    public static function getRelations(): array
    {
        return [
            RelationManagers\MembersRelationManager::class,
        ];
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListWorkspaces::route('/'),
            'edit' => Pages\EditWorkspace::route('/{record}/edit'),
            'create' => Pages\CreateWorkspace::route('/create'),
        ];
    }
}
