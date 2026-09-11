<?php

use App\Domain\Media\MediaUrls;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Events\MessageCreated;
use App\Models\Attachment;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * TC-MEDIA-001..012 subset — presigned upload flow, verification, and
 * attachment message send (FR-MEDIA-001/004, FR-MSG-002, API-060/061/062).
 *
 * Local disk (pinned in phpunit.xml) — put_url / urls.* point at signed API
 * routes exercised here through real HTTP calls.
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    // Storage::fake swaps the instance — re-register the signed-url callbacks
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);

    $this->otherWs = Workspace::factory()->create(['slug' => 'globex']);
    $this->otherWs->members()->attach($this->tony->id, ['role' => 'member']);

    $this->room = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 2,
        'last_message_at' => now(),
    ]);

    foreach ([$this->tony, $this->somchai] as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $i === 0 ? 'owner' : 'member',
            'added_by' => $this->tony->id,
        ]);
    }

    $this->png = tinyPng();
});

/**
 * Create an attachment, PUT bytes at the presigned url, complete it.
 */
function uploadFile($test, string $token, array $meta, string $bytes, array $putHeaders = []): array
{
    $created = $test->postJson('/api/v1/uploads', $meta, wsHeaders($token, 'acme'))
        ->assertStatus(201)
        ->json('data');

    $test->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $bytes)
        ->assertOk();

    $done = $test->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.attachment');

    return [$created['attachment_id'], $done];
}

// ---- API-060 create ----

test('TC-MEDIA-001 POST /uploads → 201 attachment pending + put_url + expires_at', function () {
    [$user, $token] = loginAs($this->tony);

    $res = $this->postJson('/api/v1/uploads', [
        'kind' => 'image',
        'filename' => 'cat.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data');

    expect($res['attachment_id'])->toMatch('/^[0-9A-HJKMNP-TV-Z]{26}$/i')
        ->and($res['put_url'])->toStartWith('http')
        ->and($res['expires_at'])->not->toBeNull();

    expect(Attachment::withoutGlobalScopes()->find($res['attachment_id'])->status)
        ->toBe(AttachmentStatus::Pending);
});

test('TC-MEDIA-005 size over upload.image.max_bytes → 422 MEDIA_TOO_LARGE', function () {
    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/uploads', [
        'kind' => 'image',
        'filename' => 'huge.png',
        'mime_type' => 'image/png',
        'size_bytes' => 20971521,
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_TOO_LARGE')
        ->assertJsonPath('error.details.max_bytes', 20971520);
});

test('TC-MEDIA-006 blocked extension → 422 MEDIA_TYPE_BLOCKED', function () {
    [$user, $token] = loginAs($this->tony);

    $this->postJson('/api/v1/uploads', [
        'kind' => 'file',
        'filename' => 'payload.exe',
        'mime_type' => 'application/octet-stream',
        'size_bytes' => 100,
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_TYPE_BLOCKED')
        ->assertJsonPath('error.details.extension', 'exe');
});

// ---- API-061 complete ----

test('TC-MEDIA-003 complete without PUT → 422 MEDIA_UPLOAD_MISSING', function () {
    [$user, $token] = loginAs($this->tony);

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'image',
        'filename' => 'ghost.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->json('data');

    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_UPLOAD_MISSING');
});

test('TC-MEDIA-004 size mismatch vs declared → 422 MEDIA_SIZE_MISMATCH, object deleted', function () {
    [$user, $token] = loginAs($this->tony);

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'image',
        'filename' => 'liar.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png) + 5,
    ], wsHeaders($token, 'acme'))->json('data');

    $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $this->png)->assertOk();

    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_SIZE_MISMATCH');

    expect(Storage::disk('local')->exists('ws/'.$this->ws->id.'/att/'.$created['attachment_id'].'/original'))->toBeFalse();
});

test('TC-MEDIA-007 sniffed mime ≠ declared kind → 422 MEDIA_MIME_MISMATCH (png declared as video)', function () {
    [$user, $token] = loginAs($this->tony);

    $res = $this->postJson('/api/v1/uploads', [
        'kind' => 'video',
        'filename' => 'fake.mp4',
        'mime_type' => 'video/mp4',
        'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->json('data');

    $this->call('PUT', $res['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $this->png)->assertOk();

    $this->postJson("/api/v1/uploads/{$res['attachment_id']}/complete", [], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MEDIA_MIME_MISMATCH')
        ->assertJsonPath('error.details.sniffed_mime', 'image/png');
});

test('TC-MEDIA-002/023 complete → ready (sync worker: dims + thumbs) + attachment.ready broadcast', function () {
    Event::fake([AttachmentProcessed::class]);
    [$user, $token] = loginAs($this->tony);

    [$id, $attachment] = uploadFile($this, $token, [
        'kind' => 'image',
        'filename' => 'cat.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png),
    ], $this->png);

    expect($attachment['status'])->toBe('ready')
        ->and($attachment['width'])->toBe(8)
        ->and($attachment['height'])->toBe(8)
        ->and($attachment['urls']['original'])->toStartWith('http')
        ->and($attachment['urls']['thumb_sm'])->not->toBeNull();

    // signed file route serves the object
    $file = $this->get($attachment['urls']['original']);
    $file->assertOk()->assertHeader('Content-Type', 'image/png');

    Event::assertDispatched(AttachmentProcessed::class, fn (AttachmentProcessed $e) => $e->attachment->id === $id && $e->eventName() === 'attachment.ready');
});

test('TC-MEDIA-011 complete replay → 200 idempotent, no reprocess', function () {
    Event::fake([AttachmentProcessed::class]);
    [$user, $token] = loginAs($this->tony);

    [$id, $first] = uploadFile($this, $token, [
        'kind' => 'file',
        'filename' => 'notes.txt',
        'mime_type' => 'text/plain',
        'size_bytes' => 5,
    ], 'hello');

    $again = $this->postJson("/api/v1/uploads/{$id}/complete", [], wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.attachment');

    expect($again['id'])->toBe($id)
        ->and($again['status'])->toBe('ready');

    Event::assertDispatchedTimes(AttachmentProcessed::class, 1);
});

test('complete by non-uploader → 422 MSG_ATTACHMENT_INVALID', function () {
    [$user, $token] = loginAs($this->tony);
    [$somchai, $somchaiToken] = loginAs($this->somchai);

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'image',
        'filename' => 'mine.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png),
    ], wsHeaders($token, 'acme'))->json('data');

    $this->call('PUT', $created['put_url'], [], [], [], ['CONTENT_TYPE' => 'application/octet-stream'], $this->png)->assertOk();

    $this->postJson("/api/v1/uploads/{$created['attachment_id']}/complete", [], wsHeaders($somchaiToken, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');
});

// ---- FR-MSG-002 send with attachment_ids ----

test('TC-MEDIA-008 send image-only message → type=image, attachments serialized, list preview 📷', function () {
    [$user, $token] = loginAs($this->tony);

    [$id, $attachment] = uploadFile($this, $token, [
        'kind' => 'image',
        'filename' => 'cat.png',
        'mime_type' => 'image/png',
        'size_bytes' => strlen($this->png),
    ], $this->png);

    $sent = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(201)
        ->json('data.message');

    expect($sent['type'])->toBe('image')
        ->and($sent['body'])->toBeNull()
        ->and($sent['attachments'])->toHaveCount(1)
        ->and($sent['attachments'][0]['id'])->toBe($id)
        ->and($sent['attachments'][0]['urls']['original'])->toStartWith('http');

    // room list preview shows the badge emoji
    $list = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.0.last_message');

    expect($list['body'])->toBe('📷 รูปภาพ');
});

test('file-kind attachment message → type=file, preview 📎 filename', function () {
    [$user, $token] = loginAs($this->tony);

    [$id, $attachment] = uploadFile($this, $token, [
        'kind' => 'file',
        'filename' => 'report.pdf',
        'mime_type' => 'application/pdf',
        'size_bytes' => 5,
    ], 'hello');

    $sent = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$id],
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data.message');

    expect($sent['type'])->toBe('file');

    $list = $this->getJson('/api/v1/rooms', wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.0.last_message');

    expect($list['body'])->toBe('📎 report.pdf');
});

test('mixed image+file attachments → type=file (FR-MSG-002 derivation)', function () {
    [$user, $token] = loginAs($this->tony);

    [$imageId] = uploadFile($this, $token, [
        'kind' => 'image', 'filename' => 'a.png', 'mime_type' => 'image/png', 'size_bytes' => strlen($this->png),
    ], $this->png);

    [$fileId] = uploadFile($this, $token, [
        'kind' => 'file', 'filename' => 'b.bin', 'mime_type' => 'application/octet-stream', 'size_bytes' => 3,
    ], 'xyz');

    $sent = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$imageId, $fileId],
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data.message');

    expect($sent['type'])->toBe('file')
        ->and($sent['attachments'])->toHaveCount(2);
});

test('TC-MEDIA-009 reuse of an already-attached id → 422 MSG_ATTACHMENT_INVALID', function () {
    [$user, $token] = loginAs($this->tony);

    [$id] = uploadFile($this, $token, [
        'kind' => 'file', 'filename' => 'once.txt', 'mime_type' => 'text/plain', 'size_bytes' => 5,
    ], 'hello');

    $msg = ['client_message_id' => (string) Str::uuid(), 'attachment_ids' => [$id]];

    $this->postJson("/api/v1/rooms/{$this->room->id}/messages", $msg, wsHeaders($token, 'acme'))
        ->assertStatus(201);

    $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'attachment_ids' => [$id],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');
});

test('cross-workspace attachment → 422 MSG_ATTACHMENT_INVALID (no cross-ws leak)', function () {
    [$user, $token] = loginAs($this->tony);

    // uploaded via globex context
    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'file', 'filename' => 'x.txt', 'mime_type' => 'text/plain', 'size_bytes' => 5,
    ], wsHeaders($token, 'globex'))->json('data');

    Attachment::withoutGlobalScopes()->find($created['attachment_id'])
        ->forceFill(['status' => AttachmentStatus::Ready, 'expires_at' => null])->save();

    // sent into an acme room
    $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'attachment_ids' => [$created['attachment_id']],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');
});

test('pending attachment in send → 422 MSG_ATTACHMENT_INVALID', function () {
    [$user, $token] = loginAs($this->tony);

    $created = $this->postJson('/api/v1/uploads', [
        'kind' => 'file', 'filename' => 'pending.txt', 'mime_type' => 'text/plain', 'size_bytes' => 5,
    ], wsHeaders($token, 'acme'))->json('data');

    $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'client_message_id' => (string) Str::uuid(), 'attachment_ids' => [$created['attachment_id']],
    ], wsHeaders($token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'MSG_ATTACHMENT_INVALID');
});

test('API-062 GET /attachments/{id} returns fresh signed urls', function () {
    [$user, $token] = loginAs($this->tony);

    [$id, $attachment] = uploadFile($this, $token, [
        'kind' => 'file', 'filename' => 'fresh.txt', 'mime_type' => 'text/plain', 'size_bytes' => 5,
    ], 'hello');

    $fresh = $this->getJson("/api/v1/attachments/{$id}", wsHeaders($token, 'acme'))
        ->assertOk()
        ->json('data.attachment');

    expect($fresh['status'])->toBe('ready')
        ->and($fresh['urls']['original'])->toStartWith('http')
        ->and($fresh['urls_expire_at'])->not->toBeNull();
});

test('SVG original is served as attachment, never inline (FR-MEDIA-004 XSS rule)', function () {
    [$user, $token] = loginAs($this->tony);

    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';

    [$id, $attachment] = uploadFile($this, $token, [
        'kind' => 'file', 'filename' => 'icon.svg', 'mime_type' => 'image/svg+xml', 'size_bytes' => strlen($svg),
    ], $svg);

    expect($attachment['status'])->toBe('ready'); // file kind — any non-blocked type

    $res = $this->get($attachment['urls']['original']);
    $res->assertOk();

    expect($res->headers->get('Content-Disposition'))->toContain('attachment');
});

/**
 * Minimal 8x8 PNG generated with GD (no fixture file needed).
 */
function tinyPng(): string
{
    $img = imagecreatetruecolor(8, 8);
    ob_start();
    imagepng($img);
    $bytes = (string) ob_get_clean();
    imagedestroy($img);

    return $bytes;
}

// FR-MSG-002/004/008, EVT-010: REST success must not hide missing realtime relations.
test('TC-MEDIA-012 realtime payload preserves attachments mentions and reply from REST', function () {
    [$user, $token] = loginAs($this->tony);
    [$id] = uploadFile($this, $token, [
        'kind' => 'file', 'filename' => 'realtime.txt', 'mime_type' => 'text/plain', 'size_bytes' => 5,
    ], 'hello');
    $original = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'body' => 'original', 'client_message_id' => (string) Str::uuid(),
    ], wsHeaders($token, 'acme'))->assertCreated()->json('data.message');
    Event::fake([MessageCreated::class]);
    $rest = $this->postJson("/api/v1/rooms/{$this->room->id}/messages", [
        'body' => '@somchai see attachment', 'client_message_id' => (string) Str::uuid(),
        'attachment_ids' => [$id], 'reply_to_message_id' => $original['id'],
    ], wsHeaders($token, 'acme'))->assertCreated()->json('data.message');
    expect($rest['attachments'][0]['id'])->toBe($id);
    Event::assertDispatched(MessageCreated::class, function ($event) use ($rest) {
        $payload = $event->broadcastWith()['data']['message'];
        expect($payload['attachments'])->toBe($rest['attachments'])
            ->and($payload['mentions'])->toBe($rest['mentions'])
            ->and($payload['reply_to'])->toBe($rest['reply_to']);

        return true;
    });
});

it('TC-KAN-015 rejects undecodable image bytes instead of marking them ready', function () {
    [, $token] = loginAs($this->tony);
    [, $attachment] = uploadFile($this, $token, ['kind' => 'image', 'filename' => 'broken.png', 'mime_type' => 'image/png', 'size_bytes' => 12], 'not an image');
    expect($attachment['status'])->toBe('failed');
});
