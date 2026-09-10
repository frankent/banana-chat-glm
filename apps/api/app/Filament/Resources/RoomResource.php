<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Models\Room;
use App\Models\Workspace;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class RoomResource extends BrowseResource
{
    protected static ?string $model = Room::class;

    protected static ?string $navigationIcon = 'heroicon-o-chat-bubble-left-right';

    protected static ?string $navigationGroup = 'Content';

    public static function table(Table $table): Table
    {
        return $table->defaultSort('created_at', 'desc')->columns([
            TextColumn::make('name')->searchable()->placeholder('Direct message')->description(fn (Room $r) => $r->id),
            TextColumn::make('workspace.name')->searchable(), TextColumn::make('type')->badge(),
            TextColumn::make('member_count')->label('Members')->sortable(), TextColumn::make('last_seq')->label('Messages'),
            TextColumn::make('deleted_at')->dateTime()->placeholder('Active')->label('Deleted'), TextColumn::make('purge_after')->dateTime()->label('Recovery deadline'),
        ])->filters([SelectFilter::make('workspace_id')->label('Workspace')->options(fn () => Workspace::pluck('name', 'id')), SelectFilter::make('type')->options(['dm' => 'Direct', 'group' => 'Group'])])->actions([
            Action::make('messages')->url(fn (Room $r) => MessageResource::getUrl('index', ['tableFilters' => ['room_id' => ['value' => $r->id]]])),
            Action::make('members')->modalContent(function (Room $record) {
                app(ModerationService::class)->audit(auth('admin')->user(), 'room.members_viewed_admin', $record);

                return view('filament.admin.members', ['members' => $record->members()->get()]);
            })->modalSubmitAction(false),
            Action::make('deleteRoom')->label('Delete')->color('danger')->requiresConfirmation()->visible(fn (Room $r) => ! $r->deleted_at)->action(fn (Room $record) => app(ModerationService::class)->deleteRoom(auth('admin')->user(), $record)),
            Action::make('restore')->color('success')->requiresConfirmation()->visible(fn (Room $r) => $r->deleted_at && $r->purge_after?->isFuture())->action(fn (Room $record) => app(ModerationService::class)->restoreRoom(auth('admin')->user(), $record)),
            Action::make('exportCsv')->label('Export CSV')->action(function (Room $record) {
                app(ModerationService::class)->audit(auth('admin')->user(), 'room.exported', $record);

                return response()->streamDownload(function () use ($record) {
                    $out = fopen('php://output', 'w');
                    fputcsv($out, ['seq', 'sender_id', 'body', 'created_at'], ',', '"', '');
                    foreach ($record->messages()->orderBy('seq')->cursor() as $m) {
                        $body = (string) $m->body;
                        if (preg_match('/^[=+@\-\t\r]/', $body)) {
                            $body = "'".$body;
                        }
                        fputcsv($out, [$m->seq, $m->sender_id, $body, $m->created_at?->toIso8601String()], ',', '"', '');
                    }fclose($out);
                }, 'room-'.$record->id.'.csv', ['Content-Type' => 'text/csv']);
            }),
            Action::make('export')->label('Export JSON')->action(function (Room $record) {
                app(ModerationService::class)->audit(auth('admin')->user(), 'room.exported', $record);

                return response()->streamDownload(function () use ($record) {
                    echo '[';
                    $first = true;
                    foreach ($record->messages()->orderBy('seq')->cursor() as $m) {
                        if (! $first) {
                            echo ',';
                        }echo json_encode($m->only(['id', 'seq', 'sender_id', 'body', 'type', 'created_at', 'edited_at', 'deleted_at']), JSON_UNESCAPED_UNICODE);
                        $first = false;
                    }echo ']';
                }, 'room-'.$record->id.'.json', ['Content-Type' => 'application/json']);
            }),
        ])->bulkActions([]);
    }

    public static function getPages(): array
    {
        return ['index' => RoomResource\Pages\ListRoom::route('/')];
    }
}
