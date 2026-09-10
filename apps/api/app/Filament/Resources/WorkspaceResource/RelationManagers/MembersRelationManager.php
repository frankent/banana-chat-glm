<?php

namespace App\Filament\Resources\WorkspaceResource\RelationManagers;

use App\Domain\Admin\WorkspaceMembershipService;
use App\Enums\MemberStatus;
use App\Enums\WorkspaceRole;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Filament\Forms\Components\Select;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Tables;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

/**
 * FR-ADM-005 — assign/remove members and change roles from the workspace side.
 */
class MembersRelationManager extends RelationManager
{
    protected static string $relationship = 'allMemberships'; // includes removed (history)

    public function table(Table $table): Table
    {
        return $table
            ->recordTitleAttribute('user.username')
            ->columns([
                TextColumn::make('user.username'),
                TextColumn::make('user.display_name'),
                TextColumn::make('role')
                    ->badge()
                    ->color(fn ($state): string => match ($state instanceof WorkspaceRole ? $state->value : (string) $state) {
                        'owner' => 'success', 'admin' => 'warning', default => 'gray',
                    }),
                TextColumn::make('status')->badge(),
                TextColumn::make('joined_at')
                    ->dateTime('Y-m-d H:i'),
            ])
            ->filters([])
            ->headerActions([
                Tables\Actions\Action::make('assign')
                    ->label('เพิ่มสมาชิก')
                    ->form([
                        Select::make('user_id')
                            ->label('ผู้ใช้')
                            ->options(fn (RelationManager $livewire) => User::query()
                                ->where('status', 'active')
                                ->whereNotIn('id', $livewire->getOwnerRecord()->members()->pluck('users.id'))
                                ->pluck('display_name', 'id'))
                            ->searchable()
                            ->required(),
                        Select::make('role')
                            ->options(['owner' => 'Owner', 'admin' => 'Admin', 'member' => 'Member'])
                            ->default('member')
                            ->required(),
                    ])
                    ->action(function (RelationManager $livewire, array $data): void {
                        app(WorkspaceMembershipService::class)->assign(auth('admin')->user(), $livewire->getOwnerRecord(), User::findOrFail($data['user_id']), $data['role']);
                    }),
            ])
            ->actions([
                Tables\Actions\Action::make('changeRole')
                    ->label('เปลี่ยน role')
                    ->form([
                        Select::make('role')
                            ->options(['owner' => 'Owner', 'admin' => 'Admin', 'member' => 'Member'])
                            ->default(fn (WorkspaceMember $record): string => $record->role instanceof WorkspaceRole ? $record->role->value : (string) $record->role)
                            ->required(),
                    ])
                    ->action(function (Tables\Actions\Action $action, WorkspaceMember $record, array $data): void {
                        $record->update(['role' => $data['role']]);
                        app(AuditLogger::class)->log('workspace.member_role_changed', auth('admin')->user(), 'workspace', $record->workspace_id, ['user_id' => $record->user_id, 'role' => $data['role']]);
                    }),
                Tables\Actions\Action::make('remove')
                    ->label('ถอดออก')
                    ->color('danger')
                    ->requiresConfirmation()
                    ->visible(fn (WorkspaceMember $record): bool => $record->status instanceof MemberStatus ? $record->status === MemberStatus::Active : $record->status === 'active')
                    ->action(function (WorkspaceMember $record): void {
                        app(WorkspaceMembershipService::class)->remove(auth('admin')->user(), $record);
                    }),
            ])
            ->bulkActions([]);
    }
}
