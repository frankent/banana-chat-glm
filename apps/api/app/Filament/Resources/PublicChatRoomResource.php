<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\Workspace;
use Filament\Forms\Components\DatePicker;
use Filament\Tables\Actions\Action;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\Filter;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Filters\TernaryFilter;
use Filament\Tables\Table;
use Illuminate\Contracts\Support\Htmlable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\HtmlString;

/**
 * FR-PCHAT-021 (TASK-ADM-*) — browse-only admin view of every public chat
 * conversation, cross-workspace.
 *
 * ==== READ BEFORE EDITING: EVERY STRING HERE IS ATTACKER-CONTROLLED ========
 * customer_name, provider_name, external_ref, meta and message bodies arrive
 * from the partner's own site and from an unauthenticated visitor. On this
 * surface they must therefore NEVER reach:
 *   - TextColumn::html()            (Filament escapes by default; ->html() opts out)
 *   - a blade {!! !!}               (the transcript is assembled with e() below)
 *   - a Markdown renderer           (parseMarkdown applies to the CLIENT body only)
 *   - an unguarded CSV cell         (see csvGuard(): the =+@-\t\r prefix guard is
 *                                    applied to EVERY customer-supplied column,
 *                                    not just body — FR-PCHAT-014, TC-PCHAT-030)
 * ===========================================================================
 *
 * DEC-067/071 — the Filament panel is deliberately UNAFFECTED by
 * `publicchat.enabled`. An admin must be able to read what happened precisely
 * when the feature has been switched off, so no gate is checked here.
 *
 * Browse only (FR-ADM-007/012): no create, edit, delete or bulk action. The
 * two row actions are explicit and audited.
 */
class PublicChatRoomResource extends BrowseResource
{
    protected static ?string $model = PublicChatRoom::class;

    protected static ?string $navigationIcon = 'heroicon-o-lifebuoy';

    /**
     * One of the four names already registered in
     * AdminPanelProvider::navigationGroups — a new name renders ungrouped at
     * the bottom of the sidebar.
     */
    protected static ?string $navigationGroup = 'Content';

    protected static ?string $modelLabel = 'Public chat room';

    protected static ?string $pluralModelLabel = 'Public chat rooms';

    protected static ?string $slug = 'public-chat-rooms';

    /**
     * Cross-workspace admin view. withoutGlobalScopes() drops BOTH
     * WorkspaceScope (DEC-070 — inert here anyway, since the admin panel never
     * sets WorkspaceContext) and SoftDeletingScope, so a soft-deleted room
     * still shows with its deleted_at column filled in rather than silently
     * vanishing from the moderation record.
     */
    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->withoutGlobalScopes();
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('last_message_at', 'desc')
            ->columns([
                TextColumn::make('workspace.name')->label('Workspace')->searchable(),
                // Customer-supplied. Escaped by Filament; never ->html().
                TextColumn::make('customer_name')->label('Customer')->searchable()->limit(40)
                    ->description(fn (PublicChatRoom $r): string => $r->id),
                TextColumn::make('provider_name')->label('Provider')->searchable()->limit(40),
                TextColumn::make('status')
                    ->badge()
                    ->formatStateUsing(fn ($state): string => self::statusValue($state))
                    ->color(fn ($state): string => match (self::statusValue($state)) {
                        'new' => 'gray',
                        'in_progress' => 'info',
                        'done' => 'success',
                        'problem' => 'danger',
                        default => 'gray',
                    }),
                TextColumn::make('assignedTo.display_name')->label('Assignee')->placeholder('Unassigned'),
                TextColumn::make('last_seq')->label('Messages')->sortable(),
                TextColumn::make('external_ref')->label('Ext. ref')->placeholder('—')->limit(30)->toggleable(),
                TextColumn::make('last_message_at')->label('Last activity')->dateTime('Y-m-d H:i')->placeholder('—')->sortable(),
                TextColumn::make('created_at')->dateTime('Y-m-d H:i')->sortable(),
                TextColumn::make('deleted_at')->label('Deleted')->dateTime('Y-m-d H:i')->placeholder('Active'),
            ])
            ->filters([
                SelectFilter::make('status')
                    ->multiple()
                    ->options([
                        'new' => 'New',
                        'in_progress' => 'In progress',
                        'done' => 'Done',
                        'problem' => 'Problem',
                    ]),
                SelectFilter::make('workspace_id')->label('Workspace')
                    ->options(fn (): array => Workspace::query()->orderBy('name')->pluck('name', 'id')->all()),
                SelectFilter::make('assigned_to')->label('Assignee')
                    ->relationship('assignedTo', 'display_name')
                    ->searchable(),
                TernaryFilter::make('assigned')
                    ->label('Assignment')
                    ->placeholder('Any')
                    ->trueLabel('Assigned')
                    ->falseLabel('Unassigned')
                    ->queries(
                        true: fn (Builder $q): Builder => $q->whereNotNull('assigned_to'),
                        false: fn (Builder $q): Builder => $q->whereNull('assigned_to'),
                        blank: fn (Builder $q): Builder => $q,
                    ),
                Filter::make('last_message_at')
                    ->label('Last activity')
                    ->form([
                        DatePicker::make('from')->label('Active from'),
                        DatePicker::make('until')->label('Active until'),
                    ])
                    ->query(fn (Builder $q, array $data): Builder => $q
                        ->when($data['from'] ?? null, fn (Builder $q, $d) => $q->whereDate('last_message_at', '>=', $d))
                        ->when($data['until'] ?? null, fn (Builder $q, $d) => $q->whereDate('last_message_at', '<=', $d))),
            ])
            ->actions([
                // FR-PCHAT-021: audit BEFORE the transcript renders, so an
                // admin cannot read a customer conversation without a row.
                Action::make('transcript')
                    ->label('Transcript')
                    ->icon('heroicon-o-document-text')
                    ->modalContent(function (PublicChatRoom $record): Htmlable {
                        app(ModerationService::class)->audit(auth('admin')->user(), 'public_chat.transcript_viewed', $record);

                        return self::transcriptHtml($record);
                    })
                    ->modalSubmitAction(false)
                    ->modalWidth('4xl'),

                Action::make('exportCsv')
                    ->label('Export CSV')
                    ->action(function (PublicChatRoom $record) {
                        app(ModerationService::class)->audit(auth('admin')->user(), 'public_chat.transcript_exported', $record);

                        return response()->streamDownload(function () use ($record) {
                            $out = fopen('php://output', 'w');
                            fputcsv($out, [
                                'seq', 'created_at', 'sender_kind', 'external_display_name',
                                'agent_username_snapshot', 'sender_user_id', 'customer_name',
                                'provider_name', 'external_ref', 'type', 'system_event', 'body', 'deleted_at',
                            ], ',', '"', '');

                            foreach (self::transcriptQuery($record)->cursor() as $m) {
                                fputcsv($out, [
                                    $m->seq,
                                    $m->created_at?->toIso8601String(),
                                    $m->sender_kind?->value,
                                    self::csvGuard($m->externalDisplayName()),
                                    self::csvGuard($m->agent_username_snapshot),
                                    $m->sender_user_id,
                                    self::csvGuard($record->customer_name),
                                    self::csvGuard($record->provider_name),
                                    self::csvGuard($record->external_ref),
                                    $m->type?->value,
                                    $m->system_event?->value,
                                    self::csvGuard($m->isDeleted() ? null : $m->body),
                                    $m->deleted_at?->toIso8601String(),
                                ], ',', '"', '');
                            }
                            fclose($out);
                        }, 'public-chat-'.$record->id.'.csv', ['Content-Type' => 'text/csv']);
                    }),

                Action::make('exportJson')
                    ->label('Export JSON')
                    ->action(function (PublicChatRoom $record) {
                        app(ModerationService::class)->audit(auth('admin')->user(), 'public_chat.transcript_exported', $record);

                        return response()->streamDownload(function () use ($record) {
                            echo '[';
                            $first = true;
                            foreach (self::transcriptQuery($record)->cursor() as $m) {
                                if (! $first) {
                                    echo ',';
                                }
                                echo json_encode([
                                    'id' => $m->id,
                                    'seq' => $m->seq,
                                    'created_at' => $m->created_at?->toIso8601String(),
                                    'sender_kind' => $m->sender_kind?->value,
                                    'external_display_name' => $m->externalDisplayName(),
                                    'agent_username_snapshot' => $m->agent_username_snapshot,
                                    'sender_user_id' => $m->sender_user_id,
                                    'customer_name' => $record->customer_name,
                                    'provider_name' => $record->provider_name,
                                    'external_ref' => $record->external_ref,
                                    'type' => $m->type?->value,
                                    'system_event' => $m->system_event?->value,
                                    'body' => $m->isDeleted() ? null : $m->body,
                                    'deleted_at' => $m->deleted_at?->toIso8601String(),
                                ], JSON_UNESCAPED_UNICODE);
                                $first = false;
                            }
                            echo ']';
                        }, 'public-chat-'.$record->id.'.json', ['Content-Type' => 'application/json']);
                    }),
            ])
            ->bulkActions([]);
    }

    /** @return Builder<PublicChatMessage> */
    public static function transcriptQuery(PublicChatRoom $room): Builder
    {
        return PublicChatMessage::query()
            ->withoutGlobalScopes()
            ->where('room_id', $room->id)
            ->where('workspace_id', $room->workspace_id)
            ->orderBy('seq');
    }

    /**
     * FR-PCHAT-014 / TC-PCHAT-030 — the CSV formula-injection prefix guard,
     * identical to RoomResource's, applied to EVERY customer-supplied column.
     */
    public static function csvGuard(?string $value): string
    {
        $value = (string) $value;

        return preg_match('/^[=+@\-\t\r]/', $value) === 1 ? "'".$value : $value;
    }

    /** Filament casts enum columns for us; be tolerant of a raw string too. */
    protected static function statusValue(mixed $state): string
    {
        return $state instanceof PublicChatStatus ? $state->value : (string) $state;
    }

    /**
     * The read-only transcript, assembled in PHP with e() on EVERY dynamic
     * value. This is deliberately not a blade template: the safety property
     * that matters is "no customer-supplied byte is ever interpolated
     * unescaped", and keeping the escaping on one line per value next to the
     * value makes that auditable in one screen.
     *
     * Internal identity IS shown here — this is the staff/admin surface, and
     * an admin reading a moderation record needs to know which agent answered.
     * The external display name is shown alongside it so the admin can see
     * exactly what the customer saw (FR-PCHAT-014).
     */
    public static function transcriptHtml(PublicChatRoom $room): Htmlable
    {
        $rows = [];

        $rows[] = '<div style="margin-bottom:1rem;font-size:0.875rem;line-height:1.6">'
            .'<div><strong>Customer:</strong> '.e($room->customer_name).'</div>'
            .'<div><strong>Provider:</strong> '.e($room->provider_name).'</div>'
            .'<div><strong>Status:</strong> '.e(self::statusValue($room->status))
            .' <span style="opacity:.6">(customer sees: '.e($room->statusPublic()).')</span></div>'
            .'<div><strong>External ref:</strong> '.e((string) ($room->external_ref ?? '—')).'</div>'
            .'<div><strong>Assignee:</strong> '.e($room->assignedTo?->display_name ?? 'Unassigned').'</div>'
            .'<div><strong>Locale:</strong> '.e((string) $room->locale).'</div>'
            .'</div>';

        // `meta` is $hidden on the model, so ->toArray() will not carry it —
        // read the attribute directly, and render it as escaped text in a <pre>.
        $meta = $room->meta;
        if (! empty($meta)) {
            $rows[] = '<div style="margin-bottom:1rem"><strong>meta</strong>'
                .'<pre style="white-space:pre-wrap;word-break:break-all;font-size:0.75rem">'
                .e((string) json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES))
                .'</pre></div>';
        }

        $messages = self::transcriptQuery($room)->with(['senderUser', 'attachments'])->get();

        if ($messages->isEmpty()) {
            $rows[] = '<div style="opacity:.6">No messages.</div>';
        }

        foreach ($messages as $message) {
            $rows[] = self::transcriptRowHtml($message);
        }

        return new HtmlString('<div class="fi-pchat-transcript">'.implode('', $rows).'</div>');
    }

    protected static function transcriptRowHtml(PublicChatMessage $message): string
    {
        $kind = $message->sender_kind?->value ?? 'unknown';

        $who = match ($message->sender_kind) {
            // Internal identity, shown because this is the admin surface.
            PublicChatSenderKind::Agent => trim(
                ($message->senderUser?->display_name ?? '(deleted user)')
                .' @'.($message->senderUser?->username ?? '?')
            ).' — customer saw: '.(string) $message->externalDisplayName(),
            PublicChatSenderKind::Visitor => 'Visitor',
            PublicChatSenderKind::System => 'System'.($message->system_event !== null ? ' / '.$message->system_event->value : ''),
            default => 'Unknown',
        };

        $body = $message->isDeleted()
            ? '(deleted'.($message->deleted_at !== null ? ' '.$message->deleted_at->toDateTimeString() : '').')'
            : (string) $message->body;

        // PublicChatMessage has NO SoftDeletes trait: deleted rows stay in the
        // result set, so the placeholder above is rendered here by hand.
        $html = '<div style="padding:.5rem 0;border-bottom:1px solid rgba(128,128,128,.2)">'
            .'<div style="font-size:.75rem;opacity:.7">#'.e((string) $message->seq)
            .' · '.e($kind)
            .' · '.e($who)
            .' · '.e((string) $message->created_at?->toDateTimeString())
            .' · '.e((string) ($message->type?->value ?? ''))
            .'</div>'
            .'<div style="white-space:pre-wrap;word-break:break-word">'.e($body).'</div>';

        if ($message->sender_kind === PublicChatSenderKind::System && ! empty($message->system_meta)) {
            $html .= '<pre style="white-space:pre-wrap;font-size:.7rem;opacity:.7">'
                .e((string) json_encode($message->system_meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES))
                .'</pre>';
        }

        $names = $message->attachments->map(fn ($a): string => (string) $a->original_name)->all();
        if ($names !== []) {
            $html .= '<div style="font-size:.75rem;opacity:.8">📎 '
                .implode(', ', array_map(fn (string $n): string => e($n), $names))
                .'</div>';
        }

        return $html.'</div>';
    }

    public static function getPages(): array
    {
        return ['index' => PublicChatRoomResource\Pages\ListPublicChatRooms::route('/')];
    }
}
