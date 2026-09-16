<?php

namespace App\Filament\Resources;

use App\Domain\Admin\ModerationService;
use App\Models\PublicChatApiKey;
use App\Models\User;
use App\Models\Workspace;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Tables\Actions\Action;
use Filament\Tables\Actions\CreateAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Filters\TernaryFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * FR-PCHAT-030/031/032 — partner integration credentials for the Tier-1 HMAC
 * surface.
 *
 * WHY A PLAIN Resource AND NOT BrowseResource (FR-PCHAT-032). BrowseResource's
 * documented contract is "browse and explicit actions only"; this resource
 * exists to ISSUE and REVOKE, so it extends Resource and denies edit/delete
 * individually instead. Issuance is a TABLE HEADER CreateAction using
 * ->using(), the shape already proven by UserResource's temp-password create:
 * the list page registers no create button of its own, so nothing here
 * authorises against canCreate(), and there is no create page to raw-insert a
 * row without a key_id or ciphertext.
 *
 * ==== THE PLAINTEXT SECRET — DEC-062 ======================================
 * The secret exists in plaintext for exactly one moment: inside issue(), on its
 * way into the one-time notification. It is NEVER written to the audit row (not
 * the value, not a digest of it), never a property of THIS Livewire component,
 * never a form field, never a table column, never in this resource's rendered
 * HTML, and never read back out of secret_ciphertext by any endpoint, export or
 * Filament field — the model $hidden's that column. The table shows
 * '****'.secret_last4 and nothing else. A caller who loses the secret must
 * rotate the key. TC-PCHAT-048 asserts every one of those.
 *
 * WHAT IS NOT CLAIMED, stated plainly rather than glossed. Showing a secret on
 * screen means it exists in the page. Notification::send() pushes the body into
 * the server-side session; Filament's own `notifications` Livewire component
 * pulls it exactly once (session()->pull, so a reload cannot show it again) and
 * then holds it in its own `public Collection $notifications` — i.e. in THAT
 * component's snapshot, which Livewire checksums but does not encrypt — until
 * the admin dismisses it, because ->persistent() is what stops it vanishing
 * before it can be copied. That is inherent to a show-once secret and is the
 * exact behaviour of the in-repo temp-password precedent at
 * UserResource::createUser, which FR-PCHAT-032 tells us to follow.
 * ===========================================================================
 */
class PublicChatApiKeyResource extends Resource
{
    protected static ?string $model = PublicChatApiKey::class;

    protected static ?string $navigationIcon = 'heroicon-o-key';

    protected static ?string $navigationGroup = 'System';

    protected static ?string $modelLabel = 'Public chat API key';

    protected static ?string $pluralModelLabel = 'Public chat API keys';

    protected static ?string $slug = 'public-chat-api-keys';

    /** Editing a credential in place is meaningless — rotate instead. */
    public static function canEdit($record): bool
    {
        return false;
    }

    /**
     * FR-PCHAT-032: revocation is a row UPDATE precisely so the audit trail and
     * the key's room provenance survive. Hard deletion would destroy both.
     */
    public static function canDelete($record): bool
    {
        return false;
    }

    public static function canDeleteAny(): bool
    {
        return false;
    }

    /** Cross-workspace admin view; WorkspaceContext is never set in the panel. */
    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->withoutGlobalScopes();
    }

    /** Only ever used by the header CreateAction's modal. */
    public static function form(Form $form): Form
    {
        return $form->schema([
            Select::make('workspace_id')
                ->label('Workspace')
                ->options(fn (): array => Workspace::query()->orderBy('name')->pluck('name', 'id')->all())
                ->searchable()
                ->required(),
            TextInput::make('name')
                ->label('ชื่อ (อ้างอิงภายใน)')
                ->required()
                ->maxLength(80),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('created_at', 'desc')
            ->columns([
                TextColumn::make('workspace.name')->label('Workspace')->searchable(),
                TextColumn::make('name')->searchable(),
                // key_id is PUBLIC by design (FR-PCHAT-031) — safe to log, copy
                // and show. It is not the secret.
                TextColumn::make('key_id')->label('Key ID')->copyable()->searchable(),
                TextColumn::make('secret_last4')
                    ->label('Secret')
                    ->formatStateUsing(fn ($state): string => '****'.$state)
                    ->copyable(false),
                TextColumn::make('last_used_at')->dateTime('Y-m-d H:i')->placeholder('Never'),
                TextColumn::make('revoked_at')
                    ->label('State')
                    ->badge()
                    ->formatStateUsing(fn ($state): string => $state === null ? 'Active' : 'Revoked')
                    ->color(fn ($state): string => $state === null ? 'success' : 'danger'),
                TextColumn::make('createdByAdmin.username')->label('Issued by')->placeholder('—')->toggleable(),
                TextColumn::make('created_at')->dateTime('Y-m-d H:i')->sortable(),
            ])
            ->filters([
                SelectFilter::make('workspace_id')->label('Workspace')
                    ->options(fn (): array => Workspace::query()->orderBy('name')->pluck('name', 'id')->all()),
                TernaryFilter::make('revoked')
                    ->label('State')
                    ->placeholder('Any')
                    ->trueLabel('Revoked')
                    ->falseLabel('Active')
                    ->queries(
                        true: fn (Builder $q): Builder => $q->whereNotNull('revoked_at'),
                        false: fn (Builder $q): Builder => $q->whereNull('revoked_at'),
                        blank: fn (Builder $q): Builder => $q,
                    ),
            ])
            ->headerActions([
                // FR-PCHAT-030/032 — issuance. A TABLE header action, not a
                // page-level one: the list page deliberately registers none.
                CreateAction::make('issueKey')
                    ->label('ออก API key')
                    ->modalHeading('ออก Public Chat API key')
                    ->modalSubmitActionLabel('ออก key')
                    ->createAnother(false)
                    ->using(fn (array $data): PublicChatApiKey => self::issue(
                        (string) $data['workspace_id'],
                        (string) $data['name'],
                        auth('admin')->user(),
                    ))
                    // Replaced by the one-time secret notification below.
                    ->successNotification(null),
            ])
            ->actions([
                Action::make('revoke')
                    ->label('Revoke')
                    ->color('danger')
                    ->icon('heroicon-o-no-symbol')
                    ->requiresConfirmation()
                    ->modalDescription('ห้องที่ key นี้สร้างไว้จะยังเปิดอยู่และลิงก์ของลูกค้ายังใช้ได้ (FR-PCHAT-032) — เฉพาะการเรียก API ด้วย key นี้เท่านั้นที่จะได้ 401')
                    ->visible(fn (PublicChatApiKey $record): bool => ! $record->isRevoked())
                    ->action(fn (PublicChatApiKey $record) => self::revoke($record, auth('admin')->user())),

                Action::make('rotate')
                    ->label('Rotate')
                    ->color('warning')
                    ->icon('heroicon-o-arrow-path')
                    ->requiresConfirmation()
                    ->modalDescription('เพิกถอน key เดิมและออก key ใหม่ — secret ใหม่จะแสดงเพียงครั้งเดียว')
                    ->visible(fn (PublicChatApiKey $record): bool => ! $record->isRevoked())
                    ->action(function (PublicChatApiKey $record): void {
                        $admin = auth('admin')->user();
                        DB::transaction(function () use ($record, $admin): void {
                            self::revoke($record, $admin);
                            self::issue($record->workspace_id, $record->name, $admin);
                        });
                    }),
            ])
            ->bulkActions([]);
    }

    /**
     * Issues a key and sends the ONE AND ONLY notification carrying the
     * plaintext secret.
     *
     * The audit row records key_id and name — never the secret and never a
     * digest of it (TC-PCHAT-048). ModerationService::audit re-checks
     * is_system_admin + status Active on every call, which is why the actor is
     * authorised through it rather than trusted from the panel session.
     */
    public static function issue(string $workspaceId, string $name, User $admin): PublicChatApiKey
    {
        app(ModerationService::class)->authorize($admin);

        $secret = PublicChatApiKey::generateSecret();

        $key = new PublicChatApiKey;
        $key->forceFill([
            'workspace_id' => $workspaceId,
            'name' => $name,
            'key_id' => PublicChatApiKey::generateKeyId(),
            'secret_ciphertext' => Crypt::encryptString($secret),
            'secret_last4' => substr($secret, -4),
            'created_by_admin_id' => $admin->id,
        ])->save();

        app(ModerationService::class)->audit($admin, 'public_chat.api_key_issued', $key);

        self::sendSecretOnce($key->key_id, $secret);

        return $key;
    }

    public static function revoke(PublicChatApiKey $key, User $admin): void
    {
        app(ModerationService::class)->authorize($admin);

        if ($key->isRevoked()) {
            return;
        }

        $key->forceFill(['revoked_at' => now()])->save();

        app(ModerationService::class)->audit($admin, 'public_chat.api_key_revoked', $key);
    }

    /**
     * MANDATORY graft 10 — the "server-side only, never from browser
     * JavaScript" warning is printed in the issuance notification itself, not
     * only in the integration docs. The natural integrator mistake is to sign
     * from the storefront's front end, which ships the secret to every visitor,
     * and no CORS setting can prevent it.
     *
     * ->persistent() is what keeps the secret on screen until the admin
     * dismisses it (the UserResource temp-password precedent).
     */
    protected static function sendSecretOnce(string $keyId, string $secret): void
    {
        Notification::make('pchat_secret')
            ->title('บันทึก secret นี้ทันที — จะไม่แสดงอีก')
            ->body(
                $keyId.PHP_EOL.$secret.PHP_EOL.PHP_EOL
                .'ลงลายมือชื่อฝั่งเซิร์ฟเวอร์เท่านั้น — ห้ามใช้ secret นี้จาก JavaScript ในเบราว์เซอร์ '
                .'(server-side only, never from browser JS). ระบบไม่เก็บ secret ในรูปแบบที่อ่านคืนได้ '
                .'หากทำหาย ให้ใช้ Rotate เพื่อออก key ใหม่'
            )
            ->persistent()
            ->success()
            ->send();
    }

    public static function getPages(): array
    {
        return ['index' => PublicChatApiKeyResource\Pages\ListPublicChatApiKeys::route('/')];
    }
}
