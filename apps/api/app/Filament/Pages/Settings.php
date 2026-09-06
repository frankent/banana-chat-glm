<?php

namespace App\Filament\Pages;

use App\Services\AuditLogger;
use App\Services\SettingsService;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

/**
 * FR-ADM-009 — system settings editor (§4.4). Old/new values audited,
 * changes take effect within the 60s cache window (SettingsService).
 */
class Settings extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-cog-6-tooth';

    protected static ?string $navigationLabel = 'ตั้งค่าระบบ';

    protected static ?string $title = 'System Settings';

    protected static ?int $navigationSort = 5;

    protected static string $view = 'filament.pages.settings';

    public ?array $data = [];

    public function mount(): void
    {
        $settings = app(SettingsService::class);
        $this->form->fill(collect($settings->all())
            ->only(array_keys($this->editable()))
            ->all());
    }

    public function form(Form $form): Form
    {
        return $form
            ->schema([
                Section::make('ข้อความ')
                    ->schema($this->numericFields([
                        'message.max_length' => [1, 32000],
                        'message.max_attachments' => [1, 20],
                    ])),
                Section::make('ห้อง')
                    ->schema($this->numericFields([
                        'room.group.max_members' => [2, 10000],
                        'room.deleted_purge_days' => [1, 365],
                    ])),
                Section::make('การเข้าสู่ระบบ')
                    ->schema($this->numericFields([
                        'auth.password.min_length' => [8, 128],
                        'auth.lockout.threshold' => [3, 100],
                        'auth.lockout.minutes' => [1, 1440],
                        'auth.access_token_ttl_minutes' => [5, 1440],
                        'auth.refresh_token_ttl_days' => [1, 90],
                        'auth.max_sessions_per_user' => [1, 100],
                    ])),
                Section::make('AI')
                    ->schema([
                        Toggle::make('ai.enabled')->label('เปิดใช้ AI'),
                        Toggle::make('ai.admin_review_enabled')->label('Admin review AI conversations'),
                        ...$this->numericFields([
                            'ai.daily_message_limit_per_user' => [0, 10000],
                        ]),
                    ]),
            ])
            ->statePath('data');
    }

    public function save(): void
    {
        $data = $this->form->getState();
        $settings = app(SettingsService::class);
        $editable = $this->editable();

        $old = [];
        foreach ($data as $key => $value) {
            $cast = $editable[$key];
            $normalized = $cast === 'int' ? (int) $value : (bool) $value;
            $old[$key] = $settings->get($key);
            $settings->set($key, $normalized);
        }

        $changes = collect($old)->filter(fn ($v, $k) => $old[$k] !== ($data[$k] ?? null) && (string) $old[$k] !== (string) ($data[$k] ?? ''))->all();

        app(AuditLogger::class)->log(
            'settings.updated',
            auth('admin')->user(),
            'settings',
            null,
            $changes !== [] ? ['changed' => array_keys($changes)] : ['changed' => []],
        );

        Notification::make()
            ->title('บันทึกแล้ว — มีผลภายใน 60 วินาที (cache)')
            ->success()
            ->send();
    }

    /**
     * @return array<string, string> key => 'int'|'bool'
     */
    private function editable(): array
    {
        return [
            'message.max_length' => 'int',
            'message.max_attachments' => 'int',
            'room.group.max_members' => 'int',
            'room.deleted_purge_days' => 'int',
            'auth.password.min_length' => 'int',
            'auth.lockout.threshold' => 'int',
            'auth.lockout.minutes' => 'int',
            'auth.access_token_ttl_minutes' => 'int',
            'auth.refresh_token_ttl_days' => 'int',
            'auth.max_sessions_per_user' => 'int',
            'ai.enabled' => 'bool',
            'ai.admin_review_enabled' => 'bool',
            'ai.daily_message_limit_per_user' => 'int',
        ];
    }

    /**
     * @param  array<string, array{0: int, 1: int}>  $fields
     * @return array<int, TextInput>
     */
    private function numericFields(array $fields): array
    {
        return collect($fields)->map(fn (array $range, string $key): TextInput => TextInput::make($key)
            ->label($key)
            ->numeric()
            ->minValue($range[0])
            ->maxValue($range[1])
            ->required())->values()->all();
    }
}
