<?php

namespace App\Filament\Resources\UserResource\Pages;

use App\Filament\Resources\UserResource;
use App\Services\AuditLogger;
use Filament\Actions;
use Filament\Resources\Pages\EditRecord;

class EditUser extends EditRecord
{
    protected static string $resource = UserResource::class;

    protected function getHeaderActions(): array
    {
        return [
            Actions\DeleteAction::make(),
        ];
    }

    protected function afterSave(): void
    {
        /** FR-ADM-003 — every profile edit is audited */
        $changes = $this->getRecord()->getChanges();
        unset($changes['updated_at']);

        if ($changes !== []) {
            app(AuditLogger::class)->log('user.updated', auth('admin')->user(), 'user', $this->getRecord()->id, ['fields' => array_keys($changes)]);
        }
    }
}
