<?php

namespace App\Filament\Resources\AiProviderResource\Pages;

use App\Filament\Resources\AiProviderResource;
use Filament\Resources\Pages\CreateRecord;

class CreateAiProvider extends CreateRecord
{
    protected static string $resource = AiProviderResource::class;

    protected function mutateFormDataBeforeCreate(array $data): array
    {
        $plain = (string) ($this->form->getRawState()['api_key'] ?? '');
        if ($plain === '') {
            $plain = '-'; // encrypted placeholder keeps NOT NULL happy; provider unusable until a real key
        }
        $data += AiProviderResource::encryptKey($plain);

        return AiProviderResource::mutateFormData($data, null, auth('admin')->user());
    }
}
