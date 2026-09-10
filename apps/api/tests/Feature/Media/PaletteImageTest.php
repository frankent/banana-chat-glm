<?php

use App\Domain\Media\MediaUrls;
use App\Enums\AttachmentStatus;
use App\Events\AttachmentProcessed;
use App\Jobs\ProcessAttachment;
use App\Models\{Attachment, User, Workspace};
use Illuminate\Support\Facades\{Event, Storage};

it('TC-MEDIA-022 builds WebP thumbnails from palette images without altering originals', function (string $format) {
    Event::fake([AttachmentProcessed::class]);
    Storage::fake('local');
    $disk = Storage::disk('local');
    MediaUrls::registerLocalCallbacks($disk);
    $source = imagecreate(12, 8);
    imagecolorallocate($source, 40, 150, 90);
    ob_start();
    ('image'.$format)($source);
    $bytes = ob_get_clean();
    imagedestroy($source);
    $decoded = imagecreatefromstring($bytes);
    expect(imageistruecolor($decoded))->toBeFalse();
    imagedestroy($decoded);
    $workspace = Workspace::factory()->create();
    $user = User::factory()->create();
    $attachment = Attachment::create(['workspace_id' => $workspace->id, 'uploader_id' => $user->id, 'kind' => 'image', 'status' => 'uploaded', 'original_name' => 'palette.'.$format, 'mime_type' => 'image/'.$format, 'size_bytes' => strlen($bytes), 'storage_key' => 'palette-original.'.$format]);
    $disk->put($attachment->storage_key, $bytes);
    (new ProcessAttachment($attachment))->handle();
    $attachment->refresh();
    expect($attachment->status)->toBe(AttachmentStatus::Ready)->and($attachment->derived)->toHaveKeys(['thumb_sm', 'thumb_md']);
    $thumb = imagecreatefromstring($disk->get($attachment->derived['thumb_md']));
    expect(imagesx($thumb))->toBe(12)->and(imagesy($thumb))->toBe(8)->and($disk->get($attachment->storage_key))->toBe($bytes);
    imagedestroy($thumb);
})->with(['gif', 'png']);
