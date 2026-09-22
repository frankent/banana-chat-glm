<?php

use App\Filament\Pages\PublicChatIntegration;
use App\Models\User;
use Illuminate\Support\Facades\File;
use Livewire\Livewire;

/** FR-ADM-016 — concise, downloadable Public Chat integration guide under /admin. */
test('TC-ADM-087 the page renders for a system admin and shows the resolved base host', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(PublicChatIntegration::class)
        ->assertSuccessful()
        ->assertSee(parse_url((string) config('app.url'), PHP_URL_HOST));
});

test('TC-ADM-088 downloading the full guide streams the real, moved markdown file', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(PublicChatIntegration::class)
        ->callAction('downloadGuide')
        ->assertFileDownloaded('public-chat-integration-guide.md');

    expect(File::exists(base_path('resources/docs/public-chat/README.md')))->toBeTrue();
});

test('TC-ADM-089 downloading the OpenAPI spec streams the real file', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(PublicChatIntegration::class)
        ->callAction('downloadOpenApi')
        ->assertFileDownloaded('public-chat-openapi.yaml');

    expect(File::exists(base_path('openapi.yaml')))->toBeTrue();
});

test('TC-ADM-090 the common-errors table matches the shipped error codes', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    $page = new PublicChatIntegration;
    $codes = array_column($page->commonErrors(), 'code');

    // These are the exact codes ApiException exposes for public chat — a
    // renamed/removed code here should fail this test, not just look wrong
    // on the page.
    foreach (['API_KEY_INVALID', 'API_SIGNATURE_INVALID', 'API_TIMESTAMP_SKEW', 'PCHAT_DISABLED', 'PCHAT_ROOM_NOT_FOUND', 'RATE_LIMITED'] as $expected) {
        expect($codes)->toContain($expected);
    }
});
