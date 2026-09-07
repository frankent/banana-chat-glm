<?php

use App\Filament\Resources\AiProviderResource;
use App\Filament\Resources\AiProviderResource\Pages\CreateAiProvider;
use App\Filament\Resources\AiProviderResource\Pages\ListAiProviders;
use App\Models\AiProvider;
use App\Models\User;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Livewire\Livewire;

/**
 * TC-ADM-057..063 subset (FR-AI-011/012) — provider resource: key is
 * write-only, single default invariant, test-connection persistence.
 */
beforeEach(function () {
    $this->admin = User::factory()->systemAdmin()->create();
    $this->be($this->admin, 'admin');
});

test('TC-ADM-057 provider list renders with masked key', function () {
    AiProvider::create([
        'name' => 'Z.AI GLM', 'provider_type' => 'openai_compatible',
        'base_url' => 'https://api.z.ai/api/coding/paas/v4',
        'api_key_encrypted' => Crypt::encryptString('sk-secret-abcd'),
        'api_key_last4' => 'abcd', 'model' => 'glm-5.2',
        'is_enabled' => true, 'is_default' => true,
    ]);

    Livewire::test(ListAiProviders::class)
        ->assertSuccessful()
        ->assertSeeText('Z.AI GLM')
        ->assertDontSee('sk-secret-abcd');
});

test('TC-ADM-058 creating a provider stores an encrypted key and single default', function () {
    AiProvider::create([
        'name' => 'Old default', 'provider_type' => 'openai_compatible',
        'base_url' => 'https://old.test/v1', 'api_key_encrypted' => Crypt::encryptString('k'),
        'model' => 'm1', 'is_enabled' => true, 'is_default' => true,
    ]);

    Livewire::test(CreateAiProvider::class)
        ->fillForm([
            'name' => 'New default',
            'base_url' => 'https://new.test/v1',
            'api_key' => 'sk-plain-wxyz',
            'model' => 'glm-5.2',
            'is_enabled' => true,
            'is_default' => true,
        ])
        ->call('create')
        ->assertHasNoFormErrors();

    $created = AiProvider::query()->where('name', 'New default')->first();
    expect($created)->not->toBeNull()
        ->and($created->plainApiKey())->toBe('sk-plain-wxyz')
        ->and($created->api_key_last4)->toBe('wxyz')
        // old default demoted — exactly one default row
        ->and(AiProvider::query()->where('is_default', true)->count())->toBe(1)
        ->and(AiProvider::query()->where('is_default', true)->value('id'))->toBe($created->id)
        // the key never exists in plaintext columns
        ->and(AiProvider::query()->where('api_key_encrypted', 'sk-plain-wxyz')->exists())->toBeFalse();
});

test('TC-ADM-061 test connection result is persisted (FR-AI-012)', function () {
    $provider = AiProvider::create([
        'name' => 'Ping me', 'provider_type' => 'openai_compatible',
        'base_url' => 'https://ping.test/v1', 'api_key_encrypted' => Crypt::encryptString('k'),
        'model' => 'glm-5.2', 'is_enabled' => true, 'is_default' => false,
    ]);

    Http::fake(['ping.test/*' => Http::response([
        'data' => [['id' => 'glm-5.2'], ['id' => 'glm-5.2-air']],
    ])]);

    $result = AiProviderResource::testProvider($provider);
    expect($result['ok'])->toBeTrue()
        ->and($result['models'])->toBe(['glm-5.2', 'glm-5.2-air']);

    // table action path persists it
    Livewire::withQueryParams([])
        ->test(ListAiProviders::class);

    $provider->forceFill(['last_tested_at' => now(), 'last_test_status' => $result])->save();
    expect($provider->refresh()->last_test_status['ok'])->toBeTrue();
});

test('base_url with a trailing /chat/completions is rejected', function () {
    Livewire::test(CreateAiProvider::class)
        ->fillForm([
            'name' => 'Bad URL',
            'base_url' => 'https://x.test/v1/chat/completions',
            'model' => 'm',
        ])
        ->call('create')
        ->assertHasFormErrors(['base_url']);
});
