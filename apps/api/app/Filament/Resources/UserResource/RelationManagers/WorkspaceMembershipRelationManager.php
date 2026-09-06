<?php

namespace App\Filament\Resources\UserResource\RelationManagers;

use App\Enums\MemberStatus;
use App\Enums\WorkspaceRole;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Services\AuditLogger;
use Filament\Forms\Components\Select;
use Filament\Forms\Form;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Tables;
use Filament\Tables\Actions\AttachAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

/**
 * FR-ADM-005 — assign user to workspaces with a role.
 */
class WorkspaceMembershipRelationManager extends RelationManager
{
    protected static string $relationship = 'workspaceMemberships';

    public function form(Form $form): Form
    {
        return $form
            ->schema([
                Select::make('workspace_id')
                    ->label('Workspace')
                    ->options(fn () => Workspace::query()->where('status', 'active')->pluck('name', 'id'))
                    ->searchable()
                    ->required(),
                Select::make('role')
                    ->options(['owner' => 'Owner', 'admin' => 'Admin', 'member' => 'Member'])
                    ->default('member')
                    ->required(),
            ]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->recordTitleAttribute('workspace.name')
            ->columns([
                TextColumn::make('workspace.name'),
                TextColumn::make('workspace.slug'),
                TextColumn::make('role')
                    ->badge()
                    ->color(fn ($state): string => match ($state instanceof WorkspaceRole ? $state->value : (string) $state) {
                        'owner' => 'success', 'admin' => 'warning', default => 'gray',
                    }),
                TextColumn::make('status')
                    ->badge(),
                TextColumn::make('joined_at')
                    ->dateTime('Y-m-d H:i'),
            ])
            ->filters([])
            ->headerActions([
                AttachAction::make()
                    ->label('เพิ่มเข้า workspace')
                    ->form(fn (AttachAction $action): array => [
                        $action->getRecordSelect(),
                        Select::make('role')
                            ->options(['owner' => 'Owner', 'admin' => 'Admin', 'member' => 'Member'])
                            ->default('member')
                            ->required(),
                    ])
                    ->using(function (RelationManager $livewire, array $data): void {
                        WorkspaceMember::query()->create([
                            'workspace_id' => $data['recordId'],
                            'user_id' => $livewire->getOwnerRecord()->id,
                            'role' => $data['role'],
                            'status' => 'active',
                        ]);
                        app(AuditLogger::class)->log('workspace.member_added', auth('admin')->user(), 'workspace', $data['recordId'], ['user_id' => $livewire->getOwnerRecord()->id]);
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
                    ->action(function (WorkspaceMember $record, array $data): void {
                        $record->update(['role' => $data['role']]);
                        app(AuditLogger::class)->log('workspace.member_role_changed', auth('admin')->user(), 'workspace', $record->workspace_id, ['user_id' => $record->user_id, 'role' => $data['role']]);
                    }),

                // FR-ADM-006: remove = status removed (keeps history), not a row delete
                Tables\Actions\Action::make('remove')
                    ->label('ถอดออก')
                    ->color('danger')
                    ->requiresConfirmation()
                    ->visible(fn (WorkspaceMember $record): bool => $record->status instanceof MemberStatus ? $record->status === MemberStatus::Active : $record->status === 'active')
                    ->action(function (WorkspaceMember $record): void {
                        $record->update(['status' => 'removed', 'removed_at' => now()]);
                        app(AuditLogger::class)->log('workspace.member_removed', auth('admin')->user(), 'workspace', $record->workspace_id, ['user_id' => $record->user_id]);
                    }),
            ])
            ->bulkActions([]);
    }
}
