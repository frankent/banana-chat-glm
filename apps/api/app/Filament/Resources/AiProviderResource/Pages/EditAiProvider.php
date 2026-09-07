<?php

namespace App\Filament\Resources\AiProviderResource\Pages;

use App\Filament\Resources\AiProviderResource;
use Filament\Actions;
use Filament\Resources\Pages\EditRecord;

class EditAiProvider extends EditRecord
{
    protected static string $resource = AiProviderResource::class;

    protected function getHeaderActions(): array
    {
        return [
            Actions\DeleteAction::make(),
        ];
    }

    protected function mutateFormDataBeforeSave(array $data): array
    {
        $plain = (string) ($this->form->getRawState()['api_key'] ?? '');
        if ($plain !== '') {
            $data += AiProviderResource::encryptKey($plain);
        }

        return AiProviderResource::mutateFormData($data, $this->getRecord(), auth('admin')->user());
    }
}
