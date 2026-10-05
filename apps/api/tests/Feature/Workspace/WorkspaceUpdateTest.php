<?php

use App\Domain\Media\MediaUrls;
use App\Events\WorkspaceUpdated;
use App\Jobs\PurgeOrphanAttachments;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * TC-WS-013, TC-WS-025..031 — owner/admin edits the workspace name and photo
 * (FR-WS-004, DEC-093, API-013, EVT-088). Helper names are unique: Pest
 * helpers are global across test files.
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    $this->owner = User::factory()->create(['username' => 'tony']);
    $this->admin = User::factory()->create(['username' => 'anna']);
    $this->member = User::factory()->create(['username' => 'somchai']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme', 'name' => 'Acme Co']);
    $this->ws->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->admin->id, ['role' => 'admin']);
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);

    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $this->png = (string) ob_get_clean();
    imagedestroy($img);
});

function wsInfoUpload($test, string $token, string $kind = 'avatar', bool $complete = true): string
{
    $created = $test->postJson('/api/v1/uploads', [
        'kind' => $kind, 'filename' => 'ws.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($test->png),
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data');

    if (! $complete) {
        return $created['attachment_id'];
    }

    $test->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $test->png)->assertOk();

    return $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertOk()->json('data.attachment.id');
}

test('TC-WS-013 owner and admin rename the workspace (trimmed, slug untouched); member → 403 WS_FORBIDDEN', function () {
    Event::fake([WorkspaceUpdated::class]);
    [, $ownerToken] = loginAs($this->owner);
    [, $adminToken] = loginAs($this->admin);
    [, $memberToken] = loginAs($this->member);

    $this->patchJson('/api/v1/workspace', ['name' => '  Acme Labs  '], wsHeaders($ownerToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.workspace.name', 'Acme Labs')
        ->assertJsonPath('data.workspace.slug', 'acme');

    $this->patchJson('/api/v1/workspace', ['name' => 'Acme HQ'], wsHeaders($adminToken, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.name', 'Acme HQ');

    $this->patchJson('/api/v1/workspace', ['name' => 'Hacked'], wsHeaders($memberToken, 'acme'))
        ->assertStatus(403)->assertJsonPath('error.code', 'WS_FORBIDDEN');

    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => null], wsHeaders($memberToken, 'acme'))
        ->assertStatus(403);

    expect($this->ws->refresh()->name)->toBe('Acme HQ')->and($this->ws->slug)->toBe('acme');
    Event::assertDispatchedTimes(WorkspaceUpdated::class, 2);
});

test('TC-WS-025 name validation: empty / whitespace-only / >100 → 422; unchanged → 200 with no event, no audit row', function () {
    Event::fake([WorkspaceUpdated::class]);
    [, $token] = loginAs($this->owner);

    $this->patchJson('/api/v1/workspace', ['name' => ''], wsHeaders($token, 'acme'))->assertStatus(422);
    $this->patchJson('/api/v1/workspace', ['name' => "   \t "], wsHeaders($token, 'acme'))->assertStatus(422);
    $this->patchJson('/api/v1/workspace', ['name' => str_repeat('x', 101)], wsHeaders($token, 'acme'))->assertStatus(422);

    $this->patchJson('/api/v1/workspace', ['name' => 'Acme Co'], wsHeaders($token, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.name', 'Acme Co');
    $this->patchJson('/api/v1/workspace', [], wsHeaders($token, 'acme'))->assertOk();

    Event::assertNotDispatched(WorkspaceUpdated::class);
    expect(AuditLog::query()->where('action', 'workspace.updated')->count())->toBe(0);
});

test('TC-WS-026 admin sets, replaces and removes the photo; every workspace payload carries avatar', function () {
    Event::fake([WorkspaceUpdated::class]);
    [, $adminToken] = loginAs($this->admin);
    [, $memberToken] = loginAs($this->member);

    $first = wsInfoUpload($this, $adminToken);
    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => $first], wsHeaders($adminToken, 'acme'))
        ->assertOk()
        ->assertJsonPath('data.workspace.avatar_attachment_id', $first)
        ->assertJsonPath('data.workspace.avatar.sm', fn ($sm) => str_starts_with((string) $sm, 'http'));

    // a plain member sees it on GET /workspace and /me/workspaces
    $this->getJson('/api/v1/workspace', wsHeaders($memberToken, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.avatar_attachment_id', $first)
        ->assertJsonPath('data.workspace.avatar.sm', fn ($sm) => str_starts_with((string) $sm, 'http'));
    $this->getJson('/api/v1/me/workspaces', authHeaders($memberToken))
        ->assertOk()->assertJsonPath('data.0.workspace.avatar_attachment_id', $first)
        ->assertJsonPath('data.0.workspace.avatar.md', fn ($md) => str_starts_with((string) $md, 'http'));

    $second = wsInfoUpload($this, $adminToken);
    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => $second], wsHeaders($adminToken, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.avatar_attachment_id', $second);

    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => null], wsHeaders($adminToken, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.avatar_attachment_id', null)->assertJsonPath('data.workspace.avatar', null);
    $this->getJson('/api/v1/me/workspaces', authHeaders($memberToken))->assertJsonPath('data.0.workspace.avatar', null);

    Event::assertDispatchedTimes(WorkspaceUpdated::class, 3);
});

test('TC-WS-027 foreign / pending / non-avatar-kind / unknown photo id → 422 AVATAR_INVALID and nothing saved', function () {
    [, $adminToken] = loginAs($this->admin);
    [, $memberToken] = loginAs($this->member);

    $foreign = wsInfoUpload($this, $memberToken);
    $pending = wsInfoUpload($this, $adminToken, 'avatar', false);
    $image = wsInfoUpload($this, $adminToken, 'image');

    foreach ([$foreign, $pending, $image, (string) Str::ulid()] as $id) {
        $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => $id], wsHeaders($adminToken, 'acme'))
            ->assertStatus(422)->assertJsonPath('error.code', 'AVATAR_INVALID');
    }

    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => 'not-a-ulid'], wsHeaders($adminToken, 'acme'))->assertStatus(422);

    expect($this->ws->refresh()->avatar_attachment_id)->toBeNull();
});

test('TC-WS-028 rename + photo in one PATCH: one URL-free workspace.updated and one audit row naming both fields', function () {
    Event::fake([WorkspaceUpdated::class]);
    [, $token] = loginAs($this->owner);
    $id = wsInfoUpload($this, $token);

    $this->patchJson('/api/v1/workspace', ['name' => 'Acme Labs', 'avatar_attachment_id' => $id], wsHeaders($token, 'acme'))->assertOk();

    Event::assertDispatchedTimes(WorkspaceUpdated::class, 1);
    Event::assertDispatched(WorkspaceUpdated::class, function (WorkspaceUpdated $e) {
        $wire = json_encode($e->broadcastWith());

        return $e->workspaceId === $this->ws->id
            && $e->broadcastOn()[0]->name === 'private-workspace.'.$this->ws->id
            && $e->broadcastAs() === 'workspace.updated'
            && ! str_contains($wire, 'http') && ! str_contains($wire, 'Acme Labs');
    });

    $audit = AuditLog::query()->where('action', 'workspace.updated')->sole();
    expect($audit->workspace_id)->toBe($this->ws->id)
        ->and($audit->target_id)->toBe($this->ws->id)
        ->and($audit->context['fields'])->toBe(['name', 'avatar_attachment_id']);
});

test('TC-WS-029 the photo survives the orphan purge while the workspace points at it, and is reclaimed once replaced', function () {
    [, $token] = loginAs($this->owner);
    $id = wsInfoUpload($this, $token);
    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => $id], wsHeaders($token, 'acme'))->assertOk();

    Attachment::withoutGlobalScopes()->whereKey($id)->update(['created_at' => now()->subDays(3)]);
    (new PurgeOrphanAttachments)->handle();
    expect(Attachment::withoutGlobalScopes()->whereKey($id)->exists())->toBeTrue();

    $this->patchJson('/api/v1/workspace', ['avatar_attachment_id' => null], wsHeaders($token, 'acme'))->assertOk();
    (new PurgeOrphanAttachments)->handle();
    expect(Attachment::withoutGlobalScopes()->whereKey($id)->exists())->toBeFalse();
});

test('TC-WS-030 the workspace header scopes the write: an admin of workspace A cannot edit workspace B', function () {
    $globex = Workspace::factory()->create(['slug' => 'globex', 'name' => 'Globex']);
    $globex->members()->attach($this->member->id, ['role' => 'member']);
    $globex->members()->attach($this->admin->id, ['role' => 'member']); // admin of acme, plain member of globex

    [, $adminToken] = loginAs($this->admin);

    $this->patchJson('/api/v1/workspace', ['name' => 'Pwned'], wsHeaders($adminToken, 'globex'))->assertStatus(403);
    expect($globex->refresh()->name)->toBe('Globex');
});

test('TC-WS-031 a system admin who is only a plain member of the workspace may rename it', function () {
    $sysadmin = User::factory()->create(['username' => 'root', 'is_system_admin' => true]);
    $this->ws->members()->attach($sysadmin->id, ['role' => 'member']);
    [, $token] = loginAs($sysadmin);

    $this->patchJson('/api/v1/workspace', ['name' => 'Renamed By Root'], wsHeaders($token, 'acme'))
        ->assertOk()->assertJsonPath('data.workspace.name', 'Renamed By Root');
    expect($this->ws->refresh()->name)->toBe('Renamed By Root');
});
