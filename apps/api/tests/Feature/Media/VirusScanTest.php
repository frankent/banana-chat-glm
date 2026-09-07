<?php

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Jobs\ProcessAttachment;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\Process;

/**
 * FR-MEDIA-006 / TASK-BE-023 — ClamAV virus scan on kind=file uploads
 * (TC-MEDIA-033..035) against a mock clamd server.
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');

    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
});

afterEach(function () {
    foreach ($this->clamdProcesses ?? [] as $process) {
        $process->stop();
    }
});

/** Start the mock clamd; returns the port it listens on. */
function startMockClamd($test, string $infectedMarker = 'EICAR'): int
{
    $port = random_int(33200, 33999);
    $process = new Process([PHP_BINARY, base_path('tests/Support/mock-clamd.php'), "--port={$port}", "--infected-marker={$infectedMarker}"]);
    $process->start();
    $test->clamdProcesses[] = $process;

    for ($i = 0; $i < 50; $i++) {
        if (@fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2) !== false) {
            return $port;
        }
        usleep(50_000);
    }

    throw new RuntimeException('mock clamd did not start: '.$process->getErrorOutput());
}

function makeFileAttachment($test, string $bytes, AttachmentKind $kind = AttachmentKind::File): Attachment
{
    $attachment = Attachment::withoutGlobalScopes()->create([
        'workspace_id' => $test->ws->id,
        'uploader_id' => $test->tony->id,
        'kind' => $kind,
        'status' => AttachmentStatus::Uploaded,
        'original_name' => 'doc.pdf',
        'mime_type' => 'application/pdf',
        'size_bytes' => strlen($bytes),
        'storage_key' => 'ws/'.$test->ws->id.'/att/test-original',
        'expires_at' => now()->addHour(),
    ]);
    Storage::disk('local')->put($attachment->storage_key, $bytes, 'private');

    return $attachment;
}

test('TC-MEDIA-033 ClamAV detects → failed + object deleted + audit + uploader notified', function () {
    $port = startMockClamd($this);
    config(['services.clamav.host' => '127.0.0.1', 'services.clamav.port' => $port]);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeFileAttachment($this, '%PDF-1.4 EICAR-STANDARD-ANTIVIRUS-TEST-FILE payload');
    (new ProcessAttachment($attachment))->handle();

    expect($attachment->refresh()->status)->toBe(AttachmentStatus::Failed)
        ->and($attachment->refresh()->scan_result)->toBe('infected')
        ->and(Storage::disk('local')->exists($attachment->storage_key))->toBeFalse();

    expect(
        AuditLog::query()->where('action', 'media.malware_detected')->where('target_id', $attachment->id)->exists()
    )->toBeTrue();

    Event::assertDispatched(AttachmentProcessed::class,
        fn (AttachmentProcessed $e) => $e->attachment->id === $attachment->id && $e->eventName() === 'attachment.failed');
});

test('TC-MEDIA-034 clamd down → attachment ready, scan=skipped flag + alert', function () {
    config(['services.clamav.host' => '127.0.0.1', 'services.clamav.port' => 1]); // refused
    Event::fake([AttachmentProcessed::class]);

    $captured = [];
    Log::shouldReceive('warning')->zeroOrMoreTimes()->andReturnUsing(function ($msg, $ctx = null) use (&$captured) {
        $captured[] = [$msg, is_array($ctx) ? $ctx : []];

        return null;
    });

    $attachment = makeFileAttachment($this, '%PDF-1.4 clean document');
    (new ProcessAttachment($attachment))->handle();

    expect($attachment->refresh()->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->refresh()->scan_result)->toBe('skipped')
        ->and(Storage::disk('local')->exists($attachment->storage_key))->toBeTrue();

    expect($captured)->not->toBeEmpty()
        ->and($captured[0][0])->toBe('media.clamav_scan_skipped');
});

test('TC-MEDIA-035 only kind=file is scanned; images go straight to ready', function () {
    $port = startMockClamd($this);
    config(['services.clamav.host' => '127.0.0.1', 'services.clamav.port' => $port]);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeFileAttachment($this, 'EICAR would be flagged if scanned', AttachmentKind::Image);
    (new ProcessAttachment($attachment))->handle();

    expect($attachment->refresh()->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->refresh()->scan_result)->toBeNull()
        ->and(Storage::disk('local')->exists($attachment->storage_key))->toBeTrue();
});

test('clean file gets scan_result=clean and stays ready', function () {
    $port = startMockClamd($this);
    config(['services.clamav.host' => '127.0.0.1', 'services.clamav.port' => $port]);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeFileAttachment($this, '%PDF-1.4 boring but harmless');
    (new ProcessAttachment($attachment))->handle();

    expect($attachment->refresh()->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->refresh()->scan_result)->toBe('clean');
});
