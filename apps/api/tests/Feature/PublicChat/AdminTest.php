<?php

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatSenderKind;
use App\Enums\PublicChatStatus;
use App\Enums\PublicChatSystemEvent;
use App\Filament\Pages\Auth\Login;
use App\Filament\Pages\Settings;
use App\Filament\Resources\PublicChatApiKeyResource;
use App\Filament\Resources\PublicChatApiKeyResource\Pages\ListPublicChatApiKeys;
use App\Filament\Resources\PublicChatRoomResource;
use App\Filament\Resources\PublicChatRoomResource\Pages\ListPublicChatRooms;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\PublicChatApiKey;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Livewire\Features\SupportDisablingBackButtonCache\DisableBackButtonCacheMiddleware;
use Livewire\Livewire;

/**
 * FR-PCHAT-021/030/032/033/034 — the Filament 3.3 admin surface.
 *
 * TC-PCHAT-005 revoked key keeps its rooms · 026 the panel is unaffected by the
 * kill switch · 030 attacker-controlled names render as text and are CSV-guarded
 * · 048 the plaintext secret is shown once, carries no-store, and reaches no
 * audit row, no model serialisation and no persisted component state.
 *
 * Pest loads every test file into ONE process, so every helper below is guarded
 * — a redeclaration is a fatal, not a warning. The Tier-1 signing helpers in
 * FoundationTest.php (pchatHeaders / pchatProbe / PROBE_PATH) are REUSED, never
 * redefined; nothing here needs them, so nothing here touches them.
 */
if (! defined('PCHAT_XSS_NAME')) {
    define('PCHAT_XSS_NAME', '<img src=x onerror=alert(1)>');
}

if (! function_exists('pchatAdmin')) {
    /** A system admin authenticated on the `admin` guard, as the panel uses. */
    function pchatAdmin(): User
    {
        $admin = User::factory()->systemAdmin()->create();

        // The panel's own login, as TC-ADM-070 does: actingAs() alone does not
        // satisfy every middleware on the admin guard.
        Livewire::test(Login::class)
            ->fillForm(['login' => $admin->username, 'password' => 'Password123!'])
            ->call('authenticate')
            ->assertHasNoErrors();

        return $admin;
    }
}

if (! function_exists('pchatRoom')) {
    /** @param  array<string, mixed>  $attributes */
    function pchatRoom(Workspace $workspace, array $attributes = []): PublicChatRoom
    {
        $room = new PublicChatRoom;
        $room->forceFill(array_merge([
            'workspace_id' => $workspace->id,
            'code' => PublicChatRoom::generateCode(),
            'customer_name' => 'Somchai',
            'provider_name' => 'Acme Support',
            'status' => PublicChatStatus::New,
            'locale' => 'th',
            'last_seq' => 0,
            'last_visitor_seq' => 0,
            'last_agent_seq' => 0,
            'expires_at' => now()->addDays(30),
        ], $attributes))->save();

        return $room;
    }
}

if (! function_exists('pchatMessage')) {
    /** @param  array<string, mixed>  $attributes */
    function pchatMessage(PublicChatRoom $room, int $seq, array $attributes = []): PublicChatMessage
    {
        $message = new PublicChatMessage;
        $message->forceFill(array_merge([
            'room_id' => $room->id,
            'workspace_id' => $room->workspace_id,
            'seq' => $seq,
            'sender_kind' => PublicChatSenderKind::Visitor,
            'type' => PublicChatMessageType::Text,
            'body' => 'hello',
            'client_message_id' => (string) Str::uuid(),
            'created_at' => now(),
        ], $attributes))->save();

        return $message;
    }
}

if (! function_exists('pchatPullNotifiedSecret')) {
    /**
     * Returns the plaintext secret that Filament put in the one-time
     * notification, by reading the session entry the framework itself pulls.
     * Returns null when no notification carried a `pcs_` secret.
     */
    function pchatPullNotifiedSecret(): ?string
    {
        foreach (session()->get('filament.notifications') ?? [] as $notification) {
            if (preg_match('/pcs_[0-9a-f]{64}/', (string) ($notification['body'] ?? ''), $m) === 1) {
                return $m[0];
            }
        }

        return null;
    }
}

// ---------------------------------------------------------------------------
// FR-PCHAT-021 — the rooms resource
// ---------------------------------------------------------------------------

test('FR-PCHAT-021 the rooms resource lists every workspace and never offers create/edit/delete', function () {
    $admin = pchatAdmin();
    $a = Workspace::factory()->create();
    $b = Workspace::factory()->create();
    $roomA = pchatRoom($a, ['customer_name' => 'Customer A']);
    $roomB = pchatRoom($b, ['customer_name' => 'Customer B', 'status' => PublicChatStatus::Problem]);

    // Browse-only contract (FR-ADM-007/012).
    expect(PublicChatRoomResource::canCreate())->toBeFalse()
        ->and(PublicChatRoomResource::canEdit($roomA))->toBeFalse()
        ->and(PublicChatRoomResource::canDelete($roomA))->toBeFalse()
        ->and(PublicChatRoomResource::canDeleteAny())->toBeFalse();

    Livewire::test(ListPublicChatRooms::class)
        ->assertCanSeeTableRecords([$roomA, $roomB])
        ->assertSee('Customer A')
        ->assertSee('Customer B');

    $this->get('/admin/public-chat-rooms')->assertOk();
    expect($admin->is_system_admin)->toBeTrue();
});

test('FR-PCHAT-021 status and assignee filters narrow the queue', function () {
    pchatAdmin();
    $ws = Workspace::factory()->create();
    $agent = User::factory()->create();
    $unassignedNew = pchatRoom($ws, ['customer_name' => 'Unclaimed']);
    $assignedDone = pchatRoom($ws, [
        'customer_name' => 'Resolved',
        'status' => PublicChatStatus::Done,
        'assigned_to' => $agent->id,
        'claimed_at' => now(),
    ]);

    Livewire::test(ListPublicChatRooms::class)
        ->filterTable('status', ['done'])
        ->assertCanSeeTableRecords([$assignedDone])
        ->assertCanNotSeeTableRecords([$unassignedNew]);

    Livewire::test(ListPublicChatRooms::class)
        ->filterTable('assigned_to', $agent->id)
        ->assertCanSeeTableRecords([$assignedDone])
        ->assertCanNotSeeTableRecords([$unassignedNew]);

    Livewire::test(ListPublicChatRooms::class)
        ->filterTable('assigned', false)
        ->assertCanSeeTableRecords([$unassignedNew])
        ->assertCanNotSeeTableRecords([$assignedDone]);
});

test('FR-PCHAT-021 the transcript audits BEFORE it renders and shows the agent internally and externally', function () {
    $admin = pchatAdmin();
    $ws = Workspace::factory()->create();
    $agent = User::factory()->create(['username' => 'nok', 'display_name' => 'Nok Support']);
    $room = pchatRoom($ws, [
        'customer_name' => 'Somchai',
        'provider_name' => 'Acme Support',
        'assigned_to' => $agent->id,
        'status' => PublicChatStatus::Problem,
        'meta' => ['order_id' => 'A-1', 'tier' => 'gold'],
        'external_ref' => 'TICKET-77',
    ]);

    pchatMessage($room, 1, ['body' => 'my order is late']);
    pchatMessage($room, 2, [
        'sender_kind' => PublicChatSenderKind::Agent,
        'sender_user_id' => $agent->id,
        'agent_username_snapshot' => 'nok',
        'provider_name_snapshot' => 'Acme Support',
        'body' => 'checking now',
    ]);
    pchatMessage($room, 3, [
        'sender_kind' => PublicChatSenderKind::System,
        'type' => PublicChatMessageType::System,
        'system_event' => PublicChatSystemEvent::Claimed,
        'system_meta' => ['actor_username' => 'nok'],
        'body' => null,
        'client_message_id' => PublicChatMessage::newSystemClientId(),
    ]);
    pchatMessage($room, 4, ['body' => 'secret retracted', 'deleted_at' => now(), 'deleted_by' => $agent->id]);

    // FR-PCHAT-021 — attachment NAMES appear in the transcript. The row is a
    // visitor upload: uploader_id NULL, public_chat_room_id set (DEC-068).
    $media = pchatMessage($room, 5, ['type' => PublicChatMessageType::Image, 'body' => null]);
    $attachment = new Attachment;
    $attachment->forceFill([
        'workspace_id' => $ws->id,
        'uploader_id' => null,
        'public_chat_room_id' => $room->id,
        'kind' => AttachmentKind::Image,
        'status' => AttachmentStatus::Ready,
        'original_name' => 'receipt-<b>.png',
        'mime_type' => 'image/png',
        'size_bytes' => 1024,
        'storage_key' => 'pchat/'.$room->id.'/receipt.png',
    ])->save();
    DB::table('public_chat_message_attachments')->insert([
        'message_id' => $media->id,
        'attachment_id' => $attachment->id,
        'position' => 0,
    ]);

    Livewire::test(ListPublicChatRooms::class)
        ->mountTableAction('transcript', $room)
        ->assertSee('my order is late')
        ->assertSee('checking now')
        // internal identity, because this is the admin surface…
        ->assertSee('Nok Support')
        ->assertSee('@nok')
        // …alongside exactly what the customer saw (FR-PCHAT-014).
        ->assertSee('Acme Support (nok)')
        ->assertSee('claimed')
        ->assertSee('order_id')
        // raw status AND the visitor projection, so the admin can see the gap
        ->assertSee('problem')
        ->assertSee('open')
        // PublicChatMessage has no SoftDeletes trait — the placeholder is ours
        ->assertSee('(deleted')
        ->assertDontSee('secret retracted')
        // attachment name, escaped like every other untrusted string
        ->assertSee('receipt-<b>.png')
        ->assertDontSee('receipt-<b>.png', escape: false);

    expect(AuditLog::query()
        ->where('action', 'public_chat.transcript_viewed')
        ->where('target_id', $room->id)
        ->where('actor_id', $admin->id)
        ->exists())->toBeTrue();
});

test('TC-PCHAT-030 attacker-controlled names render as text, never as markup', function () {
    pchatAdmin();
    $ws = Workspace::factory()->create();
    $room = pchatRoom($ws, [
        'customer_name' => PCHAT_XSS_NAME,
        'provider_name' => PCHAT_XSS_NAME,
        'external_ref' => PCHAT_XSS_NAME,
        'meta' => ['note' => PCHAT_XSS_NAME],
    ]);
    pchatMessage($room, 1, ['body' => PCHAT_XSS_NAME]);

    // List page: Filament escapes by default and no column opts into ->html().
    Livewire::test(ListPublicChatRooms::class)
        ->assertSee(PCHAT_XSS_NAME)                      // escaped form present
        ->assertDontSee(PCHAT_XSS_NAME, escape: false);  // raw markup absent

    // Transcript modal: assembled as an HtmlString, so every value must have
    // been run through e() by hand.
    Livewire::test(ListPublicChatRooms::class)
        ->mountTableAction('transcript', $room)
        ->assertSee(PCHAT_XSS_NAME)
        ->assertDontSee(PCHAT_XSS_NAME, escape: false);

    // And the rendered transcript really does contain the escaped bytes.
    $html = PublicChatRoomResource::transcriptHtml($room->fresh())->toHtml();
    expect($html)->toContain(e(PCHAT_XSS_NAME))
        ->and($html)->not->toContain('<img src=x')
        ->and($html)->not->toContain('onerror=alert(1)>');
});

test('TC-PCHAT-030 the CSV prefix guard covers every customer-supplied column, not just body', function () {
    // The guard itself…
    expect(PublicChatRoomResource::csvGuard('=cmd|calc'))->toBe("'=cmd|calc")
        ->and(PublicChatRoomResource::csvGuard('+1'))->toBe("'+1")
        ->and(PublicChatRoomResource::csvGuard('@SUM(A1)'))->toBe("'@SUM(A1)")
        ->and(PublicChatRoomResource::csvGuard('-2'))->toBe("'-2")
        ->and(PublicChatRoomResource::csvGuard("\tx"))->toBe("'\tx")
        ->and(PublicChatRoomResource::csvGuard("\rx"))->toBe("'\rx")
        ->and(PublicChatRoomResource::csvGuard('Somchai'))->toBe('Somchai')
        ->and(PublicChatRoomResource::csvGuard(null))->toBe('');

    // …and the export really streams guarded cells for name, provider,
    // external_ref, the external display name and the body alike.
    pchatAdmin();
    $ws = Workspace::factory()->create();
    $agent = User::factory()->create(['username' => '=nok', 'display_name' => 'Nok']);
    $room = pchatRoom($ws, [
        'customer_name' => '=cmd|calc',
        'provider_name' => '@Acme',
        'external_ref' => '-77',
    ]);
    pchatMessage($room, 1, ['body' => '=1+1']);
    pchatMessage($room, 2, [
        'sender_kind' => PublicChatSenderKind::Agent,
        'sender_user_id' => $agent->id,
        'agent_username_snapshot' => '=nok',
        'provider_name_snapshot' => '@Acme',
        'body' => 'ok',
    ]);

    $csv = pchatCaptureExport('exportCsv', $room);

    expect($csv)->toContain("'=cmd|calc")
        ->and($csv)->toContain("'@Acme")
        ->and($csv)->toContain("'-77")
        ->and($csv)->toContain("'=1+1")
        ->and($csv)->toContain("'@Acme (=nok)")
        ->and($csv)->toContain("'=nok")
        // the unguarded originals never appear at the start of a cell
        ->and($csv)->not->toContain(',=cmd|calc')
        ->and($csv)->not->toContain(',=1+1');

    $json = json_decode(pchatCaptureExport('exportJson', $room), true);
    expect($json)->toHaveCount(2)
        ->and($json[1]['external_display_name'])->toBe('@Acme (=nok)')
        ->and($json[1]['agent_username_snapshot'])->toBe('=nok')
        ->and($json[0]['sender_kind'])->toBe('visitor');
});

if (! function_exists('pchatCaptureExport')) {
    /** Runs a streamed export row action and returns its body. */
    function pchatCaptureExport(string $action, PublicChatRoom $room): string
    {
        $testable = Livewire::test(ListPublicChatRooms::class)
            ->callTableAction($action, $room)
            ->assertHasNoTableActionErrors()
            ->assertFileDownloaded();

        return (string) base64_decode((string) data_get($testable->effects, 'download.content'), true);
    }
}

test('TC-PCHAT-026 the admin transcript is unaffected by the publicchat.enabled kill switch', function () {
    pchatAdmin();
    app(SettingsService::class)->set('publicchat.enabled', false);
    app(SettingsService::class)->flush();
    expect(app(SettingsService::class)->bool('publicchat.enabled'))->toBeFalse();

    $ws = Workspace::factory()->create();
    $room = pchatRoom($ws);
    pchatMessage($room, 1, ['body' => 'still readable while paused']);

    $this->get('/admin/public-chat-rooms')->assertOk();

    Livewire::test(ListPublicChatRooms::class)
        ->assertCanSeeTableRecords([$room])
        ->mountTableAction('transcript', $room)
        ->assertSee('still readable while paused');
});

// ---------------------------------------------------------------------------
// FR-PCHAT-030/032 — API keys
// ---------------------------------------------------------------------------

test('TC-PCHAT-048 issuing a key shows the plaintext secret exactly once and leaks it nowhere else', function () {
    $admin = pchatAdmin();
    $ws = Workspace::factory()->create();

    $component = Livewire::test(ListPublicChatApiKeys::class)
        ->callTableAction('issueKey', data: ['workspace_id' => $ws->id, 'name' => 'storefront'])
        ->assertHasNoTableActionErrors();

    $key = PublicChatApiKey::query()->withoutGlobalScopes()->firstOrFail();
    $secret = pchatPullNotifiedSecret();

    // Shown once, in the one-time notification, and it is the real secret.
    expect($secret)->not->toBeNull()
        ->and($secret)->toMatch('/^pcs_[0-9a-f]{64}$/')
        ->and(Crypt::decryptString($key->secret_ciphertext))->toBe($secret)
        ->and($key->secret_last4)->toBe(substr($secret, -4))
        ->and($key->key_id)->toMatch('/^pck_[0-9a-f]{28}$/')
        ->and($key->created_by_admin_id)->toBe($admin->id)
        ->and($key->workspace_id)->toBe($ws->id);

    // MANDATORY graft 10 — the server-side-only warning ships in the
    // notification, not only in the docs.
    $body = collect(session('filament.notifications'))->pluck('body')->implode("\n");
    expect($body)->toContain('never from browser JS');

    // NOT in the audit trail — neither the value nor a digest of it.
    $audit = AuditLog::query()->get();
    expect($audit->toJson())->not->toContain($secret)
        ->and($audit->toJson())->not->toContain(hash('sha256', $secret))
        ->and($audit->toJson())->not->toContain($key->secret_ciphertext)
        ->and($audit->where('action', 'public_chat.api_key_issued')->count())->toBe(1);

    // NOT in the model's serialisation ($hidden), NOT in the component's
    // persisted Livewire state, NOT in the rendered table.
    expect($key->toJson())->not->toContain($secret)
        ->and($key->toArray())->not->toHaveKey('secret_ciphertext')
        ->and(json_encode($component->instance()->all()))->not->toContain($secret)
        ->and($component->html())->not->toContain($secret);

    // Shown EXACTLY once: the framework pulls the session entry on render, so a
    // second read finds nothing and a fresh page load cannot show it again.
    $again = pchatPullNotifiedSecret();
    session()->pull('filament.notifications');
    expect($again)->toBe($secret)
        ->and(pchatPullNotifiedSecret())->toBeNull();

    Livewire::test(ListPublicChatApiKeys::class)
        ->assertCanSeeTableRecords([$key])
        ->assertDontSee($secret)
        ->assertSee('****'.$key->secret_last4);

    $this->get('/admin/public-chat-api-keys')
        ->assertOk()
        ->assertDontSee($secret)
        ->assertDontSee($key->secret_ciphertext);
});

test('TC-PCHAT-048 every response that can render the secret carries Cache-Control: no-store', function () {
    pchatAdmin();

    $response = $this->get('/admin/public-chat-api-keys')->assertOk();

    expect($response->headers->get('Cache-Control'))->toContain('no-store')
        ->and($response->headers->get('Cache-Control'))->toContain('no-cache')
        ->and($response->headers->get('Pragma'))->toBe('no-cache');

    // The plaintext is NOT rendered in the response above: Notification::send()
    // pushes it into the session and Filament's own `notifications` Livewire
    // component pulls it in a SEPARATE /livewire/update. That response is
    // covered because the header comes from GLOBAL http-kernel middleware, not
    // from this page — assert that registration, or the coverage claim above is
    // an assumption rather than a fact.
    expect(app(Kernel::class)->hasMiddleware(DisableBackButtonCacheMiddleware::class))->toBeTrue();
});

test('TC-PCHAT-005 revoking a key is audited and leaves its rooms and links working', function () {
    $admin = pchatAdmin();
    $ws = Workspace::factory()->create();
    $key = PublicChatApiKeyResource::issue($ws->id, 'storefront', $admin);
    session()->pull('filament.notifications');

    $room = pchatRoom($ws, ['api_key_id' => $key->id]);

    Livewire::test(ListPublicChatApiKeys::class)
        ->callTableAction('revoke', $key)
        ->assertHasNoTableActionErrors();

    $key->refresh();
    $room->refresh();

    expect($key->revoked_at)->not->toBeNull()
        ->and($key->isRevoked())->toBeTrue()
        // FR-PCHAT-032: the conversation the key created is untouched.
        ->and($room->deleted_at)->toBeNull()
        ->and($room->closed_at)->toBeNull()
        ->and($room->status)->toBe(PublicChatStatus::New)
        ->and($room->code)->toHaveLength(64)
        ->and(AuditLog::query()->where('action', 'public_chat.api_key_revoked')->where('target_id', $key->id)->exists())->toBeTrue();

    // The revoke action disappears once the key is revoked; the key row stays,
    // because revocation is an UPDATE precisely so the trail survives.
    Livewire::test(ListPublicChatApiKeys::class)
        ->assertTableActionHidden('revoke', $key->fresh())
        ->assertCanSeeTableRecords([$key->fresh()]);
});

test('FR-PCHAT-032 rotate revokes the old key and issues one new secret', function () {
    $admin = pchatAdmin();
    $ws = Workspace::factory()->create();
    $old = PublicChatApiKeyResource::issue($ws->id, 'storefront', $admin);
    $oldSecret = pchatPullNotifiedSecret();
    session()->pull('filament.notifications');

    Livewire::test(ListPublicChatApiKeys::class)
        ->callTableAction('rotate', $old)
        ->assertHasNoTableActionErrors();

    $new = PublicChatApiKey::query()->withoutGlobalScopes()->whereKeyNot($old->id)->firstOrFail();
    $newSecret = pchatPullNotifiedSecret();

    expect($old->fresh()->revoked_at)->not->toBeNull()
        ->and($new->revoked_at)->toBeNull()
        ->and($new->name)->toBe('storefront')
        ->and($new->workspace_id)->toBe($ws->id)
        ->and($new->key_id)->not->toBe($old->key_id)
        ->and($newSecret)->not->toBeNull()
        ->and($newSecret)->not->toBe($oldSecret)
        ->and(PublicChatApiKey::query()->withoutGlobalScopes()->count())->toBe(2);
});

test('FR-PCHAT-032 the API key resource never exposes edit or delete', function () {
    $admin = pchatAdmin();
    $key = PublicChatApiKeyResource::issue(Workspace::factory()->create()->id, 'k', $admin);

    expect(PublicChatApiKeyResource::canEdit($key))->toBeFalse()
        ->and(PublicChatApiKeyResource::canDelete($key))->toBeFalse()
        ->and(PublicChatApiKeyResource::canDeleteAny())->toBeFalse()
        ->and(array_keys(PublicChatApiKeyResource::getPages()))->toBe(['index']);
});

// ---------------------------------------------------------------------------
// FR-PCHAT-033/034 — the kill switch on the Settings page
// ---------------------------------------------------------------------------

test('FR-PCHAT-033 the settings page renders with the publicchat keys present and ships the switch OFF', function () {
    pchatAdmin();

    expect(SettingsService::DEFAULTS['publicchat.enabled'])->toBeFalse()
        ->and(app(SettingsService::class)->bool('publicchat.enabled'))->toBeFalse();

    $page = Livewire::test(Settings::class)->assertOk();

    // Every shipped key still has a field — the page must not be taken down by
    // the publicchat additions (TC-ADM-071's invariant, re-asserted here).
    foreach (array_keys(SettingsService::DEFAULTS) as $key) {
        $page->assertFormFieldExists($key);
    }

    $page->assertFormFieldExists('publicchat.enabled');

    $this->get('/admin/settings')->assertOk();
});

test('FR-PCHAT-033 every numeric settings key has a ranges() entry, so the settings page cannot be taken down', function () {
    $ranges = Settings::ranges();

    // The exact outage class this guards: Settings::form() used to destructure
    // ranges()[$key] with no guard, so a numeric DEFAULTS key with no entry
    // threw for every admin on the very page that turns Public Chat off.
    $missing = [];
    foreach (SettingsService::DEFAULTS as $key => $default) {
        if (is_bool($default) || is_array($default) || is_string($default)) {
            continue;
        }

        if (! array_key_exists($key, $ranges)) {
            $missing[] = $key;
        }
    }

    expect($missing)->toBe([], 'numeric settings keys with no Settings::ranges() entry');

    // Pre-registered for the two keys FR-PCHAT-033 still owes DEFAULTS, so the
    // half that lands second cannot break the page on its own.
    expect($ranges)->toHaveKey('publicchat.link_ttl_days')
        ->and($ranges['publicchat.link_ttl_days'])->toBe([1, 365])
        ->and($ranges)->toHaveKey('publicchat.max_message_length')
        ->and($ranges['publicchat.max_message_length'])->toBe([1, 32000]);

    // And the helper note explaining what "off" means is on the switch itself.
    expect(Settings::HELPERS)->toHaveKey('publicchat.enabled')
        ->and(Settings::HELPERS['publicchat.enabled'])->toContain('503');
});

test('FR-PCHAT-034 an admin can flip publicchat.enabled on and back off from the settings page', function () {
    pchatAdmin();

    Livewire::test(Settings::class)
        ->fillForm(['publicchat' => ['enabled' => true]])
        ->call('save')
        ->assertHasNoFormErrors();

    expect(app(SettingsService::class)->bool('publicchat.enabled'))->toBeTrue()
        ->and(AuditLog::query()->where('action', 'settings.updated')->exists())->toBeTrue();

    Livewire::test(Settings::class)
        ->fillForm(['publicchat' => ['enabled' => false]])
        ->call('save')
        ->assertHasNoFormErrors();

    expect(app(SettingsService::class)->bool('publicchat.enabled'))->toBeFalse();
});
