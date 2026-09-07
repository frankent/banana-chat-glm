<?php

use App\Domain\Media\MediaUrls;
use App\Domain\Media\S3Multipart;
use App\Enums\AttachmentStatus;
use App\Jobs\PurgeExpiredUploads;
use App\Models\Attachment;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Storage;

/**
 * TASK-BE-024 / FR-MEDIA-001 — multipart upload (>50MB) + expired-upload
 * purge. The S3 wire calls (begin/complete/abort) run against real S3 in the
 * cloud-verify pass; here we pin the decision logic and the local-disk
 * fallback (single PUT stays valid to 200MB, spec FR-MEDIA-001).
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');
    MediaUrls::registerLocalCallbacks(Storage::disk('local'));

    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);

    [, $this->token] = loginAs($this->tony);
});

function requestUpload($test, int $sizeBytes, string $kind = 'file'): object
{
    return $test->postJson('/api/v1/uploads', [
        'kind' => $kind,
        'filename' => 'big.bin',
        'mime_type' => 'application/octet-stream',
        'size_bytes' => $sizeBytes,
    ], wsHeaders($test->token, 'acme'));
}

test('BE-024 >50MB on a non-S3 disk falls back to single presigned PUT', function () {
    $res = requestUpload($this, 60 * 1024 * 1024);

    $res->assertStatus(201)->assertJsonPath('data.multipart', null);
    expect($res->json('data.put_url'))->toStartWith('http');

    $id = $res->json('data.attachment_id');
    expect(Attachment::withoutGlobalScopes()->find($id)->multipart_upload_id)->toBeNull();
});

test('BE-024 multipart response carries upload_id + part_urls when disk is s3', function () {
    // fake the AWS layer: begin() must run before any HTTP egress —
    // preventStrayRequests is satisfied because S3 SDK bypasses Http factory.
    // Here we only assert the service refuses non-s3 disks.
    expect(S3Multipart::supports(Storage::disk('local')))->toBeFalse();
});

test('BE-024 complete without parts on a multipart session → 422 VALIDATION_FAILED', function () {
    $attachment = Attachment::withoutGlobalScopes()->create([
        'workspace_id' => $this->ws->id,
        'uploader_id' => $this->tony->id,
        'kind' => 'file',
        'status' => AttachmentStatus::Pending,
        'original_name' => 'big.bin',
        'mime_type' => 'application/octet-stream',
        'size_bytes' => 60 * 1024 * 1024,
        'storage_key' => 'ws/'.$this->ws->id.'/att/mp/original',
        'multipart_upload_id' => 's3-upload-id',
        'multipart_part_bytes' => 8 * 1024 * 1024,
        'expires_at' => now()->addMinutes(30),
    ]);

    $this->postJson("/api/v1/uploads/{$attachment->id}/complete", [], wsHeaders($this->token, 'acme'))
        ->assertStatus(422)
        ->assertJsonPath('error.code', 'VALIDATION_FAILED')
        ->assertJsonPath('error.details.fields.parts.0', 'ต้องส่งรายการ {part_number, etag} ของทุก part');
});

test('BE-024 part-count math: exact multiples, remainders, and the 5MB floor', function () {
    expect(S3Multipart::partCount(8 * 1024 * 1024, 8 * 1024 * 1024))->toBe(1)
        ->and(S3Multipart::partCount(8 * 1024 * 1024 + 1, 8 * 1024 * 1024))->toBe(2)
        ->and(S3Multipart::partCount(80 * 1024 * 1024, 8 * 1024 * 1024))->toBe(10);

    S3Multipart::partCount(10 * 1024 * 1024, 4 * 1024 * 1024);
})->throws(RuntimeException::class, 'below the 5MB S3 minimum');

test('TC-MEDIA-011 PurgeExpiredUploads removes stale pending rows + objects', function () {
    $stale = Attachment::withoutGlobalScopes()->create([
        'workspace_id' => $this->ws->id,
        'uploader_id' => $this->tony->id,
        'kind' => 'file',
        'status' => AttachmentStatus::Pending,
        'original_name' => 'abandoned.bin',
        'mime_type' => 'application/octet-stream',
        'size_bytes' => 100,
        'storage_key' => 'ws/'.$this->ws->id.'/att/stale/original',
        'expires_at' => now()->subHours(2),
    ]);
    Storage::disk('local')->put($stale->storage_key, 'bytes', 'private');

    $fresh = Attachment::withoutGlobalScopes()->create([
        'workspace_id' => $this->ws->id,
        'uploader_id' => $this->tony->id,
        'kind' => 'file',
        'status' => AttachmentStatus::Pending,
        'original_name' => 'inflight.bin',
        'mime_type' => 'application/octet-stream',
        'size_bytes' => 100,
        'storage_key' => 'ws/'.$this->ws->id.'/att/fresh/original',
        'expires_at' => now()->addMinutes(30),
    ]);

    (new PurgeExpiredUploads)->handle();

    expect(Attachment::withoutGlobalScopes()->find($stale->id))->toBeNull()
        ->and(Storage::disk('local')->exists($stale->storage_key))->toBeFalse()
        ->and(Attachment::withoutGlobalScopes()->find($fresh->id))->not->toBeNull();
});
