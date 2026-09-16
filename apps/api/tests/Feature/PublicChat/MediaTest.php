<?php

use App\Domain\Media\MediaUrls;
use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatStatus;
use App\Events\AttachmentProcessed;
use App\Events\MessageCreated;
use App\Events\NotificationAlert;
use App\Events\PublicChatMessageCreated;
use App\Events\PublicChatMessageCreatedStaff;
use App\Events\PublicChatMessageDeleted;
use App\Events\PublicChatRoomChanged;
use App\Events\PublicChatRoomChangedStaff;
use App\Events\PublicChatRoomCreated;
use App\Events\RoomActivity;
use App\Events\WorkspaceUnreadChanged;
use App\Jobs\PurgeExpiredUploads;
use App\Models\Attachment;
use App\Models\PublicChatRoom;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * FR-PCHAT-020 · DEC-068 · R6 — THE ONE SHARED SURFACE.
 *
 * `attachments` + UploadService are the single piece of machinery Public Chat
 * reuses instead of forking, because the shared code IS the security code (mime
 * sniffing, the blocked-extension deny list, the per-kind size caps). The price
 * is that a nullable `uploader_id` and a nullable `public_chat_room_id` now
 * partition one hot table between an internal and an external tenantry, and
 * that partition is this design's single point of failure (R6).
 *
 * §12.4 coverage in this file:
 *   TC-PCHAT-020 visitor ticket for image/video/file; 'avatar' 422 before UploadService
 *   TC-PCHAT-021 a public-chat attachment can NEVER be claimed by an internal message
 *   TC-PCHAT-022 an internal attachment can NEVER be claimed by a public-chat message
 *   TC-PCHAT-023 a visitor upload's ready event goes to the room channels, not private-user.
 *   TC-PCHAT-051 a claimed visitor file survives the orphan purge; an unclaimed ticket does not
 *
 * TC-PCHAT-021 and 022 are SECURITY tests, not integration tests (R6): if the
 * partition is ever loosened on either side, a customer's file becomes readable
 * from an internal room, or an internal file becomes readable by anyone holding
 * a support link.
 */

// ---------------------------------------------------------------------------
// Helpers — Pest loads every file in this directory into ONE process, so each
// is function_exists-guarded: ApiTest.php/FoundationTest.php declare the same
// names and a redeclaration is a FATAL, not a warning.
// ---------------------------------------------------------------------------

if (! function_exists('pchatCreateRoom')) {
    /** Direct-model fixture; the HMAC create path is exercised on its own. */
    function pchatCreateRoom(Workspace $workspace, array $overrides = []): PublicChatRoom
    {
        return PublicChatRoom::withoutGlobalScopes()->create(array_merge([
            'workspace_id' => $workspace->id,
            'code' => PublicChatRoom::generateCode(),
            'customer_name' => 'Somchai',
            'provider_name' => 'ACME Support',
            'status' => PublicChatStatus::New->value,
            'locale' => 'th',
            'expires_at' => now()->addDays(30),
        ], $overrides));
    }
}

if (! function_exists('pchatFakedEvents')) {
    /**
     * BROADCAST_CONNECTION is `reverb` in phpunit.xml, so anything left un-faked
     * reaches for a live socket server. Event::fake() REPLACES the dispatcher,
     * so the list must be complete — but it must also stay a LIST: a bare
     * Event::fake() would swallow Eloquent's own `creating` event and HasUlid
     * would stop assigning primary keys.
     *
     * @return list<class-string>
     */
    function pchatFakedEvents(): array
    {
        return [
            PublicChatMessageCreated::class,
            PublicChatMessageCreatedStaff::class,
            PublicChatMessageDeleted::class,
            PublicChatRoomChanged::class,
            PublicChatRoomChangedStaff::class,
            PublicChatRoomCreated::class,
            NotificationAlert::class,
        ];
    }
}

if (! function_exists('pchatMediaEvents')) {
    /**
     * The public-chat set PLUS everything an INTERNAL message send emits
     * (MessageWriter::fanOut) — this file writes on both sides of the partition
     * on purpose, so both broadcast sets must be caught.
     *
     * @return list<class-string>
     */
    function pchatMediaEvents(): array
    {
        return array_merge(pchatFakedEvents(), [
            MessageCreated::class,
            RoomActivity::class,
            WorkspaceUnreadChanged::class,
            AttachmentProcessed::class,
        ]);
    }
}

if (! function_exists('pchatAttachment')) {
    /**
     * An attachment row placed on ONE side of the partition, deliberately built
     * with forceFill rather than create(): `public_chat_room_id` is not in
     * Attachment::$fillable, so a mass assignment would silently drop the very
     * column under test and every assertion here would pass for the wrong
     * reason.
     */
    function pchatAttachment(Workspace $workspace, array $overrides = []): Attachment
    {
        $attachment = new Attachment;

        $attachment->forceFill(array_merge([
            'workspace_id' => $workspace->id,
            'uploader_id' => null,
            'public_chat_room_id' => null,
            'kind' => AttachmentKind::File->value,
            'status' => AttachmentStatus::Ready->value,
            'original_name' => 'receipt.pdf',
            'mime_type' => 'application/pdf',
            'size_bytes' => 1024,
            'storage_key' => 'ws/'.$workspace->id.'/att/'.Str::ulid()->toBase32().'/original',
        ], $overrides))->save();

        return $attachment->refresh();
    }
}

beforeEach(function () {
    Event::fake(pchatMediaEvents());

    // Signed URLs in AttachmentSerializer resolve against the default disk;
    // Storage::fake swaps the instance, so the callbacks must be re-registered.
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    // DEC-071 ships the feature OFF; every write below needs it on.
    app(SettingsService::class)->set('publicchat.enabled', true);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->otherWs = Workspace::factory()->create(['slug' => 'globex']);

    $this->agent = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai S.']);
    $this->ws->members()->attach($this->agent->id, ['role' => 'owner']);
    $this->otherWs->members()->attach($this->agent->id, ['role' => 'member']);

    // An ordinary internal room, used for both halves of the partition test.
    $this->internalRoom = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->agent->id,
        'owner_id' => $this->agent->id,
        'member_count' => 1,
        'last_message_at' => now(),
    ]);

    RoomMember::query()->create([
        'room_id' => $this->internalRoom->id,
        'user_id' => $this->agent->id,
        'workspace_id' => $this->ws->id,
        'role' => 'owner',
        'added_by' => $this->agent->id,
    ]);

    $this->room = pchatCreateRoom($this->ws);
});

// ===========================================================================
// TC-PCHAT-020 — the visitor's upload ticket
// ===========================================================================

it('TC-PCHAT-020 issues a visitor upload ticket for image, video and file with a NULL uploader', function () {
    foreach ([
        ['image', 'photo.png', 'image/png'],
        ['video', 'clip.mp4', 'video/mp4'],
        ['file', 'receipt.pdf', 'application/pdf'],
    ] as [$kind, $filename, $mime]) {
        $response = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/uploads', [
            'kind' => $kind,
            'filename' => $filename,
            'mime_type' => $mime,
            'size_bytes' => 2048,
        ]);

        $response->assertStatus(201);
        // The visitor holds a capability URL, never a cacheable one.
        expect($response->headers->get('Cache-Control'))->toContain('no-store');

        $attachment = Attachment::withoutGlobalScopes()->findOrFail($response->json('attachment.id'));

        // The whole partition in three assertions: nobody owns it on the
        // internal side, the ROOM owns it on the public side, and the
        // attachments_owner_chk CHECK is satisfied by the second of those.
        expect($attachment->uploader_id)->toBeNull()
            ->and($attachment->public_chat_room_id)->toBe($this->room->id)
            ->and($attachment->workspace_id)->toBe($this->ws->id)
            ->and($attachment->kind->value)->toBe($kind);
    }
});

it("TC-PCHAT-020 rejects the 'avatar' kind with 422 BEFORE UploadService is reached", function () {
    $response = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/uploads', [
        'kind' => 'avatar',
        'filename' => 'me.png',
        'mime_type' => 'image/png',
        'size_bytes' => 2048,
    ]);

    // UploadService would accept 'avatar' — it is in self::KINDS. The rejection
    // has to happen in the request layer, and it has to be VALIDATION_FAILED on
    // the `kind` field, not the service's generic error, or the guard has moved
    // and an avatar could be minted with a NULL uploader.
    $response->assertStatus(422)->assertJsonPath('error.code', 'VALIDATION_FAILED');
    expect($response->json('error.details.fields.kind'))->not->toBeNull();

    // Nothing was created at all: no row, therefore no ticket to complete.
    expect(Attachment::withoutGlobalScopes()->count())->toBe(0);
});

it('FR-PCHAT-020 lets the visitor send a video and a file message from its own attachments', function () {
    $video = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::Video->value,
        'original_name' => 'evidence.mp4',
        'mime_type' => 'video/mp4',
    ]);

    $sent = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => null,
        'attachment_ids' => [$video->id],
    ]);

    $sent->assertStatus(201)
        ->assertJsonPath('message.type', PublicChatMessageType::Video->value)
        ->assertJsonPath('message.attachments.0.id', $video->id);

    // The public attachment payload is a WHITELIST: no uploader of any shape
    // reaches the customer, even though this row's uploader happens to be NULL.
    $encoded = (string) json_encode($sent->json('message.attachments'));
    expect($encoded)->not->toContain('uploader')
        ->and($sent->json('message.attachments.0.urls'))->not->toBeNull();

    $file = pchatAttachment($this->ws, ['public_chat_room_id' => $this->room->id]);

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'body' => 'here is the receipt',
        'attachment_ids' => [$file->id],
    ])->assertStatus(201)->assertJsonPath('message.type', PublicChatMessageType::File->value);

    expect(DB::table('public_chat_message_attachments')->count())->toBe(2);
});

// ===========================================================================
// TC-PCHAT-021 — the internal side of the partition (SECURITY)
// ===========================================================================

it('TC-PCHAT-021 refuses an internal message claiming a VISITOR upload', function () {
    $visitorFile = pchatAttachment($this->ws, ['public_chat_room_id' => $this->room->id]);

    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/rooms/'.$this->internalRoom->id.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$visitorFile->id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    expect(DB::table('message_attachments')->where('attachment_id', $visitorFile->id)->exists())->toBeFalse();
});

it('TC-PCHAT-021 refuses an internal message claiming an AGENT upload that belongs to a public chat room', function () {
    // The sharp case. A visitor upload is refused for a second reason as well
    // (uploader_id NULL never equals the sender's ULID), so it cannot prove the
    // partition guard exists. An API-225 agent ticket CAN: uploader_id is the
    // agent AND public_chat_room_id is the support room, so every check in
    // MessageWriter::claimAttachments passes except the one this design
    // requires — ->whereNull('public_chat_room_id').
    //
    // If this test goes green only because of the uploader test, delete the
    // guard and it stays green: that is why the fixture is uploaded BY the
    // sender who then tries to spend it internally.
    $agentTicket = pchatAttachment($this->ws, [
        'uploader_id' => $this->agent->id,
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::Image->value,
        'original_name' => 'screenshot.png',
        'mime_type' => 'image/png',
    ]);

    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/rooms/'.$this->internalRoom->id.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$agentTicket->id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    expect(DB::table('message_attachments')->where('attachment_id', $agentTicket->id)->exists())->toBeFalse();
});

// ===========================================================================
// TC-PCHAT-022 — the public side of the partition (SECURITY)
// ===========================================================================

it('TC-PCHAT-022 refuses a public chat message claiming an INTERNAL attachment', function () {
    $internalFile = pchatAttachment($this->ws, [
        'uploader_id' => $this->agent->id,
        'public_chat_room_id' => null,
        'original_name' => 'salaries.xlsx',
    ]);

    // The visitor tier: the attacker holds a code and guesses a ULID.
    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$internalFile->id],
    ])->assertStatus(422)->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    // The agent tier, where uploader_id DOES match the actor — the ownership
    // test that saves the internal side is useless here, so the public claim
    // must be ROOM-scoped, never uploader-scoped.
    [, $token] = loginAs($this->agent);

    $this->postJson('/api/v1/public-chat/rooms/'.$this->room->id.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$internalFile->id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    expect(DB::table('public_chat_message_attachments')->where('attachment_id', $internalFile->id)->exists())->toBeFalse();
});

it('TC-PCHAT-022 refuses an attachment belonging to another public chat room or another workspace', function () {
    $neighbour = pchatCreateRoom($this->ws);
    $neighbourFile = pchatAttachment($this->ws, ['public_chat_room_id' => $neighbour->id]);

    $foreignRoom = pchatCreateRoom($this->otherWs);
    $foreignFile = pchatAttachment($this->otherWs, ['public_chat_room_id' => $foreignRoom->id]);

    foreach ([$neighbourFile, $foreignFile] as $attachment) {
        $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
            'client_message_id' => (string) Str::uuid(),
            'attachment_ids' => [$attachment->id],
        ])->assertStatus(422)->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');
    }

    expect(DB::table('public_chat_message_attachments')->count())->toBe(0);
});

it('TC-PCHAT-022 refuses a visitor attachment that has already been spent on a message', function () {
    $file = pchatAttachment($this->ws, ['public_chat_room_id' => $this->room->id]);

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$file->id],
    ])->assertStatus(201);

    // A DIFFERENT client_message_id: this is a second message, not an
    // idempotent replay, so the pivot check is the only thing standing between
    // one upload and unlimited re-posts of it.
    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$file->id],
    ])->assertStatus(422)->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    expect(DB::table('public_chat_message_attachments')->where('attachment_id', $file->id)->count())->toBe(1);
});

// ===========================================================================
// TC-PCHAT-023 — EVT-084, the event that has no uploader to send to
// ===========================================================================

it('TC-PCHAT-023 routes a visitor attachment ready event to BOTH room channels, never to private-user.', function () {
    $visitorFile = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::Image->value,
        'status' => AttachmentStatus::Ready->value,
    ]);

    $channels = array_map('strval', (new AttachmentProcessed($visitorFile))->broadcastOn());

    // With uploader_id NULL the historical channel name is the literal string
    // 'private-user.' — a live, subscribable channel that belongs to nobody, and
    // a thumbnail the visitor only ever sees after a manual reload.
    expect($channels)->not->toContain('private-user.')
        ->and($channels)->toContain('private-public-chat.'.$this->room->id)
        ->and($channels)->toContain('private-public-chat-staff.'.$this->room->id)
        ->and($channels)->toHaveCount(2);
});

it('TC-PCHAT-023 leaves an ordinary internal attachment on its uploader channel', function () {
    $internalFile = pchatAttachment($this->ws, [
        'uploader_id' => $this->agent->id,
        'public_chat_room_id' => null,
        'kind' => AttachmentKind::Image->value,
    ]);

    // EVT-030 is unchanged for everyone else: the branch must be a branch, not
    // a replacement.
    expect(array_map('strval', (new AttachmentProcessed($internalFile))->broadcastOn()))
        ->toBe(['private-user.'.$this->agent->id]);
});

// ===========================================================================
// TC-PCHAT-051 — the orphan purge
// ===========================================================================

it('TC-PCHAT-051 purges an unclaimed expired visitor ticket but keeps one a message already claimed', function () {
    // An abandoned ticket: the visitor asked for an upload URL and vanished.
    $abandoned = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Pending->value,
        'original_name' => 'never-uploaded.pdf',
    ]);
    $abandoned->forceFill(['expires_at' => now()->subDays(2)])->save();

    // A real customer file, sent 25 hours ago and part of the transcript.
    $claimed = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'original_name' => 'receipt.pdf',
    ]);

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$claimed->id],
    ])->assertStatus(201);

    $claimed->forceFill(['created_at' => now()->subDays(2), 'expires_at' => now()->subDays(2)])->save();

    // §12 names this job PurgeOrphanAttachments; the job that exists and owns
    // this behaviour today is PurgeExpiredUploads. What matters is the rule, not
    // the class name: an attachment referenced by a public_chat_message_attachments
    // row is part of a customer's transcript and deleting it destroys evidence.
    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($abandoned->id)->exists())->toBeFalse()
        ->and(Attachment::withoutGlobalScopes()->whereKey($claimed->id)->exists())->toBeTrue()
        ->and(DB::table('public_chat_message_attachments')->where('attachment_id', $claimed->id)->exists())->toBeTrue();
});
