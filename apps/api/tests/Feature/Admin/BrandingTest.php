<?php

use App\Filament\Pages\Settings;
use App\Models\AppSetting;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Livewire\Livewire;

/** FR-ADM-015/DEC-082 — admin-uploaded system logo. */
beforeEach(function () {
    Storage::fake('local');
});

test('TC-ADM-080 public app-config and logo endpoints are null/404 when unset', function () {
    $this->getJson('/api/v1/app-config')->assertOk()->assertJson(['data' => ['logo_url' => null]]);
    $this->getJson('/api/v1/branding/logo')->assertNotFound();
});

test('TC-ADM-081 admin uploads a logo; it is served and reflected in app-config, cache-busted', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(Settings::class)
        ->set('data.branding_logo_upload', UploadedFile::fake()->image('logo.png', 64, 64))
        ->call('save')
        ->assertHasNoErrors();

    $path = app(SettingsService::class)->get('branding.logo_path');
    expect($path)->toBeString()->not->toBe('');
    Storage::disk('local')->assertExists($path);

    $config = $this->getJson('/api/v1/app-config')->assertOk()->json('data.logo_url');
    expect($config)->toContain('/api/v1/branding/logo?v=');

    $this->get(parse_url($config, PHP_URL_PATH).'?'.parse_url($config, PHP_URL_QUERY))
        ->assertOk()
        ->assertHeader('Content-Type', 'image/png');
});

test('TC-ADM-082 removing the logo deletes the file and reverts both endpoints', function () {
    $admin = User::factory()->systemAdmin()->create();
    $this->actingAs($admin, 'admin');

    $page = Livewire::test(Settings::class)
        ->set('data.branding_logo_upload', UploadedFile::fake()->image('logo.png', 64, 64))
        ->call('save')
        ->assertHasNoErrors();

    $path = app(SettingsService::class)->get('branding.logo_path');
    Storage::disk('local')->assertExists($path);

    $page->call('mountAction', 'removeLogo')->callMountedAction();

    expect(app(SettingsService::class)->get('branding.logo_path'))->toBeNull();
    Storage::disk('local')->assertMissing($path);
    $this->getJson('/api/v1/app-config')->assertOk()->assertJson(['data' => ['logo_url' => null]]);
    $this->getJson('/api/v1/branding/logo')->assertNotFound();
});

/**
 * Codex implementation-review finding — upload, save, remove, then save
 * AGAIN with no new file picked. Without clearing the FileUpload field's
 * Livewire state after both save() and removeLogo(), the already-consumed
 * (and by now deleted) path survives in memory and gets written straight
 * back on this second save, leaving `branding.logo_path` pointing at a file
 * that no longer exists on disk.
 */
test('TC-ADM-083 upload, save, remove, save again does not resurrect the deleted path', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    $page = Livewire::test(Settings::class)
        ->set('data.branding_logo_upload', UploadedFile::fake()->image('logo.png', 64, 64))
        ->call('save')
        ->assertHasNoErrors();

    $uploadedPath = app(SettingsService::class)->get('branding.logo_path');
    expect($uploadedPath)->toBeString();

    $page->call('mountAction', 'removeLogo')->callMountedAction();
    expect(app(SettingsService::class)->get('branding.logo_path'))->toBeNull();

    $page->call('save')->assertHasNoErrors();

    expect(app(SettingsService::class)->get('branding.logo_path'))->toBeNull();
    $this->getJson('/api/v1/app-config')->assertOk()->assertJson(['data' => ['logo_url' => null]]);
});

test('TC-ADM-084 uploading a new logo deletes the previous file', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    $page = Livewire::test(Settings::class)
        ->set('data.branding_logo_upload', UploadedFile::fake()->image('first.png', 64, 64))
        ->call('save')
        ->assertHasNoErrors();
    $firstPath = app(SettingsService::class)->get('branding.logo_path');
    Storage::disk('local')->assertExists($firstPath);

    $page->set('data.branding_logo_upload', [UploadedFile::fake()->image('second.png', 64, 64)])
        ->call('save')
        ->assertHasNoErrors();
    $secondPath = app(SettingsService::class)->get('branding.logo_path');

    expect($secondPath)->not->toBe($firstPath);
    Storage::disk('local')->assertMissing($firstPath);
    Storage::disk('local')->assertExists($secondPath);
});

test('TC-ADM-085 removing an already-unset logo is a no-op and the action stays hidden', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(Settings::class)->assertActionHidden('removeLogo');
});

test('TC-ADM-086 the audit log records the logo change with old/new paths', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');

    Livewire::test(Settings::class)
        ->set('data.branding_logo_upload', UploadedFile::fake()->image('logo.png', 64, 64))
        ->call('save')
        ->assertHasNoErrors();

    $path = app(SettingsService::class)->get('branding.logo_path');
    $log = \App\Models\AuditLog::query()->where('action', 'settings.updated')->latest()->first();
    expect($log)->not->toBeNull();
    expect($log->context['changed'] ?? [])->toContain('branding.logo_path');
    expect($log->context['new']['branding.logo_path'] ?? null)->toBe($path);
});
