<?php

namespace App\Filament\Resources;

use App\Filament\Resources\AuditLogResource\Pages;
use App\Models\AuditLog;
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Form;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\Filter;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\Response;

/**
 * FR-ADM-008 — append-only audit log viewer: filter by actor/action/date/ws,
 * CSV export, no delete anywhere (TASK-ADM-006).
 */
class AuditLogResource extends Resource
{
    protected static ?string $model = AuditLog::class;

    protected static ?string $navigationIcon = 'heroicon-o-clock';

    protected static ?int $navigationSort = 4;

    public static function canCreate(): bool
    {
        return false; // append-only
    }

    public static function form(Form $form): Form
    {
        return $form->schema([]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('created_at', 'desc')
            ->columns([
                TextColumn::make('created_at')
                    ->dateTime('Y-m-d H:i:s')
                    ->sortable(),
                TextColumn::make('actor_id')
                    ->label('Actor')
                    ->formatStateUsing(fn ($state, AuditLog $record): string => $record->actor?->username ?? ($record->actor_type->value ?? '—'))
                    ->url(fn (AuditLog $record): ?string => $record->actor_id !== null ? UserResource::getUrl('edit', ['record' => $record->actor_id]) : null),
                TextColumn::make('action')
                    ->badge()
                    ->color(fn (string $state): string => match (true) {
                        str_starts_with($state, 'auth.') => 'info',
                        str_starts_with($state, 'room.') => 'warning',
                        str_starts_with($state, 'user.') => 'danger',
                        default => 'gray',
                    }),
                TextColumn::make('target_type')
                    ->placeholder('—'),
                TextColumn::make('workspace.slug')
                    ->placeholder('—'),
                TextColumn::make('context')
                    ->formatStateUsing(fn ($state): string => $state !== null ? json_encode($state, JSON_UNESCAPED_UNICODE) : '—')
                    ->limit(60)
                    ->tooltip(fn ($state): string => $state !== null ? json_encode($state, JSON_UNESCAPED_UNICODE) : '—'),
                TextColumn::make('ip')
                    ->placeholder('—'),
            ])
            ->filters([
                SelectFilter::make('action')
                    ->options(fn (): array => AuditLog::query()->distinct()->orderBy('action')->pluck('action', 'action')->all()),
                SelectFilter::make('workspace_id')
                    ->label('Workspace')
                    ->relationship('workspace', 'slug'),
                Filter::make('created_at')
                    ->form([
                        DatePicker::make('from'),
                        DatePicker::make('until'),
                    ])
                    ->query(function (Builder $query, array $data): Builder {
                        return $query
                            ->when($data['from'] ?? null, fn (Builder $q, $date) => $q->whereDate('created_at', '>=', $date))
                            ->when($data['until'] ?? null, fn (Builder $q, $date) => $q->whereDate('created_at', '<=', $date));
                    }),
            ])
            ->actions([])
            ->bulkActions([])
            ->headerActions([
                Tables\Actions\Action::make('exportCsv')
                    ->label('Export CSV')
                    ->icon('heroicon-o-arrow-down-tray')
                    ->action(function (Table $table): void {
                        $rows = $table->getQuery()->limit(50000)->get(['created_at', 'actor_id', 'actor_type', 'action', 'target_type', 'target_id', 'workspace_id', 'context', 'ip']);

                        $csv = implode("\n", $rows->map(fn (AuditLog $r) => implode(',', array_map(
                            fn ($v) => '"'.str_replace('"', '""', (string) ($v ?? '')).'"',
                            [$r->created_at?->toIso8601String(), $r->actor_id, $r->actor_type?->value, $r->action, $r->target_type, $r->target_id, $r->workspace_id, json_encode($r->context, JSON_UNESCAPED_UNICODE), $r->ip]
                        )))->all());

                        Response::streamDownload(
                            fn () => print ($csv),
                            'audit-log-'.now()->format('Ymd-His').'.csv',
                            ['Content-Type' => 'text/csv'],
                        );
                    }),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListAuditLogs::route('/'),
        ];
    }
}
