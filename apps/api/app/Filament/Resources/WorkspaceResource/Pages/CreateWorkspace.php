<?php

namespace App\Filament\Resources\WorkspaceResource\Pages;

use App\Filament\Resources\WorkspaceResource;
use App\Services\AuditLogger;
use Filament\Resources\Pages\CreateRecord;

class CreateWorkspace extends CreateRecord
{
    protected static string $resource = WorkspaceResource::class;

    protected function afterCreate(): void
    {
        app(AuditLogger::class)->log('workspace.created', auth('admin')->user(), 'workspace', $this->getRecord()->id, ['slug' => $this->getRecord()->slug]);
    }
}
