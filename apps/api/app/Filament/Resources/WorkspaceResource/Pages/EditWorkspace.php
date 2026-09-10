<?php

namespace App\Filament\Resources\WorkspaceResource\Pages;

use App\Filament\Resources\WorkspaceResource;
use App\Services\AuditLogger;
use Filament\Resources\Pages\EditRecord;

class EditWorkspace extends EditRecord
{
    protected static string $resource = WorkspaceResource::class;

    protected function getHeaderActions(): array
    {
        return [
            // Archive preserves conversations and membership history.
        ];
    }

    protected function afterSave(): void
    {
        $changes = $this->getRecord()->getChanges();
        unset($changes['updated_at']);

        if ($changes !== []) {
            app(AuditLogger::class)->log('workspace.updated', auth('admin')->user(), 'workspace', $this->getRecord()->id, ['fields' => array_keys($changes)]);
        }
    }
}
