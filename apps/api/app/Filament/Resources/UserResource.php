<?php

namespace App\Filament\Resources;

use App\Domain\Admin\AdminUserService;
use App\Enums\UserStatus;
use App\Filament\Resources\UserResource\Pages;
use App\Filament\Resources\UserResource\RelationManagers;
use App\Models\User;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Tables\Actions\Action;
use Filament\Tables\Actions\CreateAction;
use Filament\Tables\Actions\EditAction;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

/**
 * FR-ADM-002/003/004 — user management (TASK-ADM-002..004).
 */
class UserResource extends Resource
{
    protected static ?string $model = User::class;

    protected static ?string $navigationIcon = 'heroicon-o-users';

    protected static ?int $navigationSort = 1;

    public static function form(Form $form): Form
    {
        return $form
            ->schema([
                TextInput::make('username')
                    ->required()
                    ->maxLength(50)
                    ->unique(ignoreRecord: true)
                    ->helperText('ภาษาอังกฤษตัวพิมพ์เล็ก ตัวเลข . _ -'),
                TextInput::make('display_name')
                    ->required()
                    ->maxLength(80),
                Select::make('locale')
                    ->options(['th' => 'ไทย', 'en' => 'English'])
                    ->default('th'),
                Toggle::make('is_system_admin')
                    ->label('System admin')
                    ->helperText('เข้าถึง /admin ได้')
                    ->default(false)
                    ->columnSpan(1),
            ]);
    }

    public static function table(Table $table): Table
    {
        $service = app(AdminUserService::class);

        return $table
            ->columns([
                TextColumn::make('username')
                    ->searchable()
                    ->sortable(),
                TextColumn::make('display_name')
                    ->searchable()
                    ->sortable(),
                TextColumn::make('status')
                    ->badge()
                    ->formatStateUsing(fn ($state): string => $state instanceof UserStatus ? $state->value : (string) $state)
                    ->color(fn ($state): string => match ($state instanceof UserStatus ? $state->value : (string) $state) {
                        'active' => 'success',
                        'suspended' => 'warning',
                        'deactivated' => 'danger',
                        default => 'gray',
                    }),
                IconColumn::make('is_system_admin')
                    ->label('SA')
                    ->boolean(),
                TextColumn::make('locked_until')
                    ->dateTime('Y-m-d H:i')
                    ->placeholder('—')
                    ->color(fn ($state): string => $state !== null ? 'danger' : 'gray'),
                TextColumn::make('created_at')
                    ->dateTime('Y-m-d')
                    ->sortable(),
            ])
            ->filters([
                SelectFilter::make('status')
                    ->options(array_combine(
                        array_map(fn ($s) => $s->value, UserStatus::cases()),
                        array_map(fn ($s) => $s->value, UserStatus::cases()),
                    )),
                SelectFilter::make('is_system_admin')
                    ->options([true => 'ใช่', false => 'ไม่ใช่']),
            ])
            ->actions([
                EditAction::make(),

                // FR-ADM-002: temp password generated on create, shown exactly once
                CreateAction::make('createUser')
                    ->label('สร้างผู้ใช้')
                    ->mutateFormDataUsing(function (array $data): array {
                        // hash happens in AdminUserService; placeholder satisfies the NOT NULL
                        $data['password_hash'] = 'set-by-service';

                        return $data;
                    })
                    ->using(function (array $data, User $record, CreateAction $action) use ($service): User {
                        [$user, $tempPassword] = $service->createUser(
                            actor: auth('admin')->user() ?? auth()->user(),
                            username: $data['username'],
                            displayName: $data['display_name'],
                            locale: $data['locale'] ?? 'th',
                        );

                        $action
                            ->successNotificationTitle('สร้างผู้ใช้สำเร็จ')
                            ->success(
                                Notification::make('temp')
                                    ->title('รหัสผ่านชั่วคราว (แสดงครั้งเดียว)')
                                    ->body($tempPassword)
                                    ->persistent()
                                    ->success()
                            );

                        return $user;
                    }),

                // FR-ADM-003: suspend / unsuspend
                Action::make('suspend')
                    ->label('ระงับ')
                    ->icon('heroicon-o-pause-circle')
                    ->color('warning')
                    ->requiresConfirmation()
                    ->visible(fn (User $record): bool => $record->status === UserStatus::Active)
                    ->action(function (User $record) use ($service): void {
                        $service->suspend(auth('admin')->user(), $record);
                        Notification::make()->title("ระงับ {$record->username} แล้ว (revoke ทุก session)")->success()->send();
                    }),
                Action::make('unsuspend')
                    ->label('ปลดระงับ')
                    ->icon('heroicon-o-play-circle')
                    ->color('success')
                    ->visible(fn (User $record): bool => $record->status === UserStatus::Suspended)
                    ->action(function (User $record) use ($service): void {
                        $service->unsuspend(auth('admin')->user(), $record);
                        Notification::make()->title("ปลดระงับ {$record->username} แล้ว")->success()->send();
                    }),

                // FR-ADM-003: deactivate (permanent)
                Action::make('deactivate')
                    ->label('ปิดบัญชี')
                    ->icon('heroicon-o-x-circle')
                    ->color('danger')
                    ->requiresConfirmation()
                    ->modalDescription('ถาวร — revoke sessions, ถอดจากทุก workspace และห้อง')
                    ->visible(fn (User $record): bool => $record->status !== UserStatus::Deactivated)
                    ->action(function (User $record) use ($service): void {
                        $service->deactivate(auth('admin')->user(), $record);
                        Notification::make()->title("ปิดบัญชี {$record->username} แล้ว")->success()->send();
                    }),

                // FR-ADM-004: reset password — new temp shown once
                Action::make('resetPassword')
                    ->label('รีเซ็ตรหัสผ่าน')
                    ->icon('heroicon-o-key')
                    ->requiresConfirmation()
                    ->modalDescription('จะสร้างรหัสผ่านชั่วคราวใหม่ และ revoke ทุก session')
                    ->action(function (User $record) use ($service): void {
                        $temp = $service->resetPassword(auth('admin')->user(), $record);
                        Notification::make()
                            ->title("รีเซ็ตรหัสผ่าน {$record->username} แล้ว")
                            ->body("รหัสผ่านชั่วคราว (แสดงครั้งเดียว): {$temp}")
                            ->persistent()
                            ->success()
                            ->send();
                    }),

                // FR-ADM-004: unlock
                Action::make('unlock')
                    ->label('ปลดล็อก')
                    ->icon('heroicon-o-lock-open')
                    ->visible(fn (User $record): bool => $record->locked_until !== null)
                    ->action(function (User $record) use ($service): void {
                        $service->unlock(auth('admin')->user(), $record);
                        Notification::make()->title('ปลดล็อกแล้ว')->success()->send();
                    }),
            ])
            ->bulkActions([]);
    }

    public static function getRelations(): array
    {
        return [
            RelationManagers\WorkspaceMembershipRelationManager::class,
        ];
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListUsers::route('/'),
            'edit' => Pages\EditUser::route('/{record}/edit'),
        ];
    }
}
