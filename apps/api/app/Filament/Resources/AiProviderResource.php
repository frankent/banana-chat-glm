<?php

namespace App\Filament\Resources;

use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Filament\Resources\AiProviderResource\Pages;
use App\Models\AiProvider;
use App\Models\Workspace;
use App\Services\AuditLogger;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\Placeholder;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Tabs;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Form;
use Filament\Forms\Get;
use Filament\Forms\Set;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Tables\Actions\Action;
use Filament\Tables\Actions\EditAction;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Contracts\Support\Htmlable;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\HtmlString;

/**
 * FR-AI-011/012 (TASK-ADM-012) — System Admin provider config. The API key
 * is write-only (encrypted at rest, last4 shown); test connection and
 * model loading hit the provider directly and persist last_test_status.
 */
class AiProviderResource extends Resource
{
    protected static ?string $navigationGroup = 'AI';

    protected static ?string $model = AiProvider::class;

    protected static ?string $navigationIcon = 'heroicon-o-sparkles';

    protected static ?int $navigationSort = 6;

    public static function form(Form $form): Form
    {
        return $form
            ->schema([
                Tabs::make('Provider')->tabs([
                    Tabs\Tab::make('ทั่วไป')->schema([
                        TextInput::make('name')
                            ->label('ชื่อ (แสดงในระบบ)')
                            ->required()->maxLength(60)
                            ->unique(ignoreRecord: true),
                        Select::make('provider_type')
                            ->label('API Provider')
                            ->options(['openai_compatible' => 'OpenAI Compatible'])
                            ->default('openai_compatible')
                            ->disabled()
                            ->dehydrated(),
                        TextInput::make('base_url')
                            ->label('Base URL')
                            ->required()
                            ->url()
                            ->startsWith('https://')
                            ->rule(fn () => function (string $attribute, $value, \Closure $fail): void {
                                if (str_ends_with(rtrim((string) $value, '/'), '/chat/completions')) {
                                    $fail('ระบบจะเรียก {base}/chat/completions เอง — ตัด "/chat/completions" ท้าย URL ออก');
                                }
                            })
                            ->formatStateUsing(fn ($state) => rtrim((string) $state, '/'))
                            ->helperText('เช่น https://api.z.ai/api/coding/paas/v4'),
                        TextInput::make('api_key')
                            ->label('API Key')
                            ->password()->revealable()
                            ->dehydrated(false)
                            ->helperText(function (?AiProvider $record): string {
                                return $record?->api_key_last4 !== null
                                    ? 'ปัจจุบัน: ****'.$record->api_key_last4.' (ใส่ค่าใหม่เพื่อเปลี่ยน)'
                                    : 'ยังไม่ได้ตั้งค่า';
                            }),
                        TextInput::make('model')
                            ->label('Model')
                            ->required()->maxLength(100)
                            ->helperText('เช่น glm-5.2 (โหลดรายการด้านล่าง หรือพิมพ์เอง)'),
                        Select::make('model_source')
                            ->options(['custom' => 'Use custom', 'list' => 'จากรายการโหลด'])
                            ->default('custom'),
                        TextInput::make('memory_model')
                            ->label('Memory/Summary model (optional)')
                            ->maxLength(100),
                        Toggle::make('is_enabled')->label('เปิดใช้งาน')->default(true),
                        Toggle::make('is_default')->label('ตั้งเป็น default (ได้ 1 รายการ)'),
                        CheckboxList::make('allowed_workspace_ids')
                            ->label('Allowed workspaces (ว่าง = ทั้งหมด)')
                            ->options(fn (): array => Workspace::query()->orderBy('name')->pluck('name', 'id')->all())
                            ->dehydrated(fn (Get $get): bool => true)
                            ->afterStateHydrated(function (Set $set, ?AiProvider $record): void {
                                $set('allowed_workspace_ids', $record?->allowed_workspace_ids ?? []);
                            }),
                    ]),
                    Tabs\Tab::make('พารามิเตอร์')->schema([
                        TextInput::make('window_size')
                            ->label('Window Size (tokens)')
                            ->numeric()->default(200000)->minValue(4096)->maxValue(10000000)
                            ->helperText('glm-5.2 = 1,000,000; โมเดลอื่น 200,000'),
                        TextInput::make('max_output_tokens')
                            ->numeric()->default(4096)->minValue(256)->maxValue(131072),
                        TextInput::make('temperature')
                            ->numeric()->default(0.7)->minValue(0)->maxValue(2)->step(0.1),
                        TextInput::make('timeout_seconds')
                            ->label('Timeout (วินาที, first token)')
                            ->numeric()->default(60)->minValue(10)->maxValue(300),
                        TextInput::make('daily_message_limit_per_user')
                            ->numeric()->nullable()->minValue(1)
                            ->helperText('ว่าง = ใช้ค่า default ของระบบ (200)'),
                        Textarea::make('system_prompt')
                            ->label('System prompt')
                            ->maxLength(4000)
                            ->default('คุณคือผู้ช่วย AI ขององค์กร ตอบภาษาไทยกระชับและตรงประเด็น')
                            ->columnSpanFull(),
                    ]),
                    Tabs\Tab::make('ทดสอบการเชื่อมต่อ')->schema([
                        Placeholder::make('last_test_status')
                            ->label('')
                            ->content(fn (?AiProvider $record): Htmlable => new HtmlString(
                                view('filament.ai-provider.test-status', ['record' => $record])->render()
                            ))
                            ->columnSpanFull(),
                        Placeholder::make('loaded_models')
                            ->label('ตัวเลือกโมเดลที่โหลดได้')
                            ->content(fn (?AiProvider $record): Htmlable => new HtmlString(
                                view('filament.ai-provider.loaded-models', ['record' => $record])->render()
                            ))
                            ->columnSpanFull(),
                    ]),
                ]),
            ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->searchable()->sortable(),
                TextColumn::make('model')->badge(),
                TextColumn::make('base_url')->limit(40)->copyable(),
                IconColumn::make('is_enabled')->boolean()->label('เปิดใช้'),
                IconColumn::make('is_default')->boolean()->label('Default'),
                TextColumn::make('api_key_last4')
                    ->label('Key')
                    ->formatStateUsing(fn ($state) => $state ? '****'.$state : '—'),
                TextColumn::make('last_tested_at')->dateTime('Y-m-d H:i')->placeholder('—'),
                TextColumn::make('last_test_status.ok')
                    ->label('สถานะทดสอบ')
                    ->badge()
                    ->formatStateUsing(fn ($state) => $state === true ? 'ผ่าน' : ($state === false ? 'ไม่ผ่าน' : '—'))
                    ->color(fn ($state) => $state === true ? 'success' : ($state === false ? 'danger' : 'gray')),
            ])
            ->actions([
                EditAction::make(),

                // FR-AI-012 — Test connection (records latency + result)
                Action::make('testConnection')
                    ->label('ทดสอบการเชื่อมต่อ')
                    ->icon('heroicon-o-signal')
                    ->action(function (AiProvider $record): void {
                        $result = self::testProvider($record);
                        $record->forceFill([
                            'last_tested_at' => now(),
                            'last_test_status' => $result,
                        ])->save();

                        $ok = $result['ok'] === true;
                        Notification::make()
                            ->title($ok ? 'เชื่อมต่อได้ ('.$result['latency_ms'].'ms)' : 'เชื่อมต่อไม่ได้')
                            ->body($ok ? null : ($result['error'] ?? 'unknown error'))
                            ->status($ok ? 'success' : 'danger')
                            ->send();
                    }),

                // FR-AI-012 — Load model list into the session for the form
                Action::make('loadModels')
                    ->label('โหลดรายการโมเดล')
                    ->icon('heroicon-o-arrow-down-tray')
                    ->action(function (AiProvider $record): void {
                        try {
                            $models = (new OpenAiCompatibleProvider($record))->listModels();
                            cache()->put("ai-provider-models:{$record->id}", $models, now()->addMinutes(30));
                            Notification::make()
                                ->title('โหลดได้ '.count($models).' โมเดล')
                                ->body(implode(', ', array_slice($models, 0, 10)).(count($models) > 10 ? ' …' : ''))
                                ->success()->send();
                        } catch (AiProviderException $e) {
                            Notification::make()
                                ->title('โหลดไม่สำเร็จ: '.$e->errorCode)
                                ->body($e->providerDetail ?? $e->getMessage())
                                ->danger()->send();
                        }
                    }),
            ])
            ->bulkActions([]);
    }

    /**
     * mutateData before create/update: encrypt the key when provided,
     * keep the single-default invariant, audit changes (key never logged).
     */
    public static function mutateFormData(array $data, ?AiProvider $record, object $user): array
    {
        unset($data['api_key']); // never round-trips

        if (isset($data['allowed_workspace_ids']) && $data['allowed_workspace_ids'] === []) {
            $data['allowed_workspace_ids'] = null; // [] = all (null in DB)
        }

        if (! empty($data['is_default'])) {
            AiProvider::query()->where('is_default', true)
                ->when($record?->id, fn ($q, $id) => $q->whereKeyNot($id))
                ->update(['is_default' => false]);
        }

        $data['updated_by'] = $user->id;
        if ($record === null) {
            $data['created_by'] = $user->id;
        }

        app(AuditLogger::class)->log('ai.provider.updated', $user, 'ai_provider', $record?->id ?? '-',
            ['base_url' => $data['base_url'] ?? null, 'model' => $data['model'] ?? null]);

        return $data;
    }

    public static function testProvider(AiProvider $record): array
    {
        try {
            return (new OpenAiCompatibleProvider($record))->testConnection();
        } catch (AiProviderException $e) {
            return ['ok' => false, 'latency_ms' => 0, 'error' => $e->errorCode.': '.($e->providerDetail ?? $e->getMessage())];
        }
    }

    public static function encryptKey(string $plain): array
    {
        return [
            'api_key_encrypted' => Crypt::encryptString($plain),
            'api_key_last4' => mb_substr($plain, -4),
        ];
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListAiProviders::route('/'),
            'edit' => Pages\EditAiProvider::route('/{record}/edit'),
            'create' => Pages\CreateAiProvider::route('/create'),
        ];
    }
}
