<?php

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Jobs\ProcessAttachment;
use App\Models\Attachment;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;

/**
 * FR-MEDIA-004 video pipeline (closes DEC-034, TC-MEDIA-036..038) — poster
 * frames + duration/dimensions when ffmpeg is present; lite no-op when it
 * isn't. Uses fake ffmpeg/ffprobe scripts so no real binaries are needed.
 */
beforeEach(function () {
    config()->set('filesystems.default', 'local');
    Storage::fake('local');

    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
});

afterEach(function () {
    foreach ($this->fakeBinaries ?? [] as $path) {
        @unlink($path);
    }
    @unlink($this->posterSource ?? '');
});

/**
 * Writes fake ffmpeg/ffprobe shell scripts and points config at them.
 * - ffprobe prints canned JSON metadata
 * - ffmpeg copies $posterSource to its last argument (the output frame)
 */
function useFakeFfmpeg($test): void
{
    // a real PNG frame for the poster — GD must decode it downstream
    $png = imagecreatetruecolor(1600, 900);
    imagefill($png, 0, 0, imagecolorallocate($png, 250, 204, 21));
    $test->posterSource = tempnam(sys_get_temp_dir(), 'poster-src').'.png';
    imagepng($png, $test->posterSource);
    imagedestroy($png);

    $dir = sys_get_temp_dir();

    $ffprobe = $dir.'/fake-ffprobe-'.bin2hex(random_bytes(4)).'.sh';
    file_put_contents($ffprobe, <<<'SH'
#!/bin/sh
echo '{"streams":[{"codec_type":"video","width":1600,"height":900,"duration":"12.5"}],"format":{"duration":"12.5"}}'
SH
    );

    $ffmpeg = $dir.'/fake-ffmpeg-'.bin2hex(random_bytes(4)).'.sh';
    file_put_contents($ffmpeg, <<<SH
#!/bin/sh
# real invocations end with the output path — copy the frame there
for last in "\$@"; do :; done
cp "{$test->posterSource}" "\$last"
SH
    );

    chmod($ffprobe, 0755);
    chmod($ffmpeg, 0755);
    $test->fakeBinaries = [$ffprobe, $ffmpeg];

    config([
        'services.ffmpeg.probe_binary' => $ffprobe,
        'services.ffmpeg.binary' => $ffmpeg,
    ]);
}

function makeVideoAttachment($test, string $bytes = 'MOCK-VIDEO-BYTES'): Attachment
{
    $attachment = Attachment::withoutGlobalScopes()->create([
        'workspace_id' => $test->ws->id,
        'uploader_id' => $test->tony->id,
        'kind' => AttachmentKind::Video,
        'status' => AttachmentStatus::Uploaded,
        'original_name' => 'clip.mp4',
        'mime_type' => 'video/mp4',
        'size_bytes' => strlen($bytes),
        'storage_key' => 'ws/'.$test->ws->id.'/att/video-original',
        'expires_at' => now()->addHour(),
    ]);
    Storage::disk('local')->put($attachment->storage_key, $bytes, 'private');

    return $attachment;
}

test('TC-MEDIA-036 ffmpeg available → duration/dimensions + webp poster thumbs', function () {
    useFakeFfmpeg($this);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeVideoAttachment($this);
    (new ProcessAttachment($attachment))->handle();

    $attachment = $attachment->refresh();
    expect($attachment->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->width)->toBe(1600)
        ->and($attachment->height)->toBe(900)
        ->and($attachment->duration_ms)->toBe(12500);

    $derived = $attachment->derived ?? [];
    expect($derived)->toHaveKeys(['thumb_sm', 'thumb_md']);
    foreach ($derived as $key) {
        expect(Storage::disk('local')->exists($key))->toBeTrue();
        $thumb = imagecreatefromstring(Storage::disk('local')->get($key));
        expect($thumb)->not->toBeFalse();
        imagedestroy($thumb);
    }

    // thumb_sm is downscaled from the 1600px poster
    $sm = imagecreatefromstring(Storage::disk('local')->get($derived['thumb_sm']));
    expect(imagesx($sm))->toBe(400);
    imagedestroy($sm);
});

test('TC-MEDIA-037 no ffmpeg (lite path) → video ready immediately, no metadata/poster', function () {
    config([
        'services.ffmpeg.binary' => '/nonexistent/ffmpeg-lite-test',
        'services.ffmpeg.probe_binary' => '/nonexistent/ffprobe-lite-test',
    ]);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeVideoAttachment($this);
    (new ProcessAttachment($attachment))->handle();

    $attachment = $attachment->refresh();
    expect($attachment->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->width)->toBeNull()
        ->and($attachment->height)->toBeNull()
        ->and($attachment->duration_ms)->toBeNull()
        ->and($attachment->derived)->toBeNull();

    Event::assertDispatched(AttachmentProcessed::class,
        fn (AttachmentProcessed $e) => $e->attachment->id === $attachment->id && $e->eventName() === 'attachment.ready');
});

test('TC-MEDIA-038 ffmpeg probe fails → still ready, poster best-effort only', function () {
    // probe binary that always fails, poster binary that always fails
    $dir = sys_get_temp_dir();
    $fail = $dir.'/fake-fail-'.bin2hex(random_bytes(4)).'.sh';
    file_put_contents($fail, "#!/bin/sh\nexit 1\n");
    chmod($fail, 0755);
    $this->fakeBinaries = [$fail];

    config([
        'services.ffmpeg.binary' => $fail,
        'services.ffmpeg.probe_binary' => $fail,
    ]);
    Event::fake([AttachmentProcessed::class]);

    $attachment = makeVideoAttachment($this);
    (new ProcessAttachment($attachment))->handle();

    $attachment = $attachment->refresh();
    expect($attachment->status)->toBe(AttachmentStatus::Ready)
        ->and($attachment->duration_ms)->toBeNull()
        ->and($attachment->derived)->toBeNull();
});
