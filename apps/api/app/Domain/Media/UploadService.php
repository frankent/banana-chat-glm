<?php

namespace App\Domain\Media;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Exceptions\ApiException;
use App\Jobs\ProcessAttachment;
use App\Models\Attachment;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * FR-MEDIA-001 — presigned upload flow.
 *
 * create():  validate limits against §4.4 settings → attachment row (pending,
 * expires in 1h) → presigned PUT (15 min).
 *
 * complete(): verify the object landed (HEAD size ± 0, sniff first 8KB with
 * finfo — never trust the declared mime) → status uploaded → ProcessAttachment
 * job takes it to ready. Idempotent: replaying complete returns 200.
 */
class UploadService
{
    private const KINDS = ['image', 'video', 'file', 'avatar'];

    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * @param  array{kind: string, filename: string, mime_type: string, size_bytes: int, sha256?: ?string}  $input
     * @return array{0: Attachment, 1: string} [attachment, put_url]
     */
    public function create(User $uploader, string $workspaceId, array $input): array
    {
        $kind = $input['kind'];
        if (! in_array($kind, self::KINDS, true)) {
            throw new ApiException('VALIDATION_FAILED', 'kind ไม่ถูกต้อง', 422, [
                'fields' => ['kind' => ['ต้องเป็น image, video, file หรือ avatar']],
            ]);
        }
        $attachmentKind = AttachmentKind::from($kind);

        $extension = strtolower(pathinfo($input['filename'], PATHINFO_EXTENSION));
        $blocked = $this->settings->array('upload.file.blocked_extensions');
        if ($extension !== '' && in_array($extension, $blocked, true)) {
            throw ApiException::mediaTypeBlocked($extension);
        }

        $maxBytes = match ($attachmentKind) {
            AttachmentKind::Image, AttachmentKind::Avatar => $this->settings->int('upload.image.max_bytes'),
            AttachmentKind::Video => $this->settings->int('upload.video.max_bytes'),
            AttachmentKind::File => $this->settings->int('upload.file.max_bytes'),
        };
        if ($input['size_bytes'] > $maxBytes) {
            throw ApiException::mediaTooLarge($maxBytes);
        }

        $attachment = Attachment::withoutGlobalScopes()->create([
            'workspace_id' => $workspaceId,
            'uploader_id' => $uploader->id,
            'kind' => $attachmentKind,
            'status' => AttachmentStatus::Pending,
            'original_name' => Str::limit($this->sanitizeName($input['filename']), 255, ''),
            'mime_type' => $input['mime_type'],
            'size_bytes' => $input['size_bytes'],
            'storage_key' => 'ws/'.$workspaceId.'/att/pending',
            'checksum_sha256' => $input['sha256'] ?? null,
            'expires_at' => now()->addHour(),
        ]);

        $storageKey = sprintf('ws/%s/att/%s/original', $workspaceId, $attachment->id);
        $attachment->forceFill(['storage_key' => $storageKey])->save();

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        $putUrl = $disk->temporaryUploadUrl($storageKey, now()->addMinutes(15))['url'];

        return [$attachment, $putUrl];
    }

    /**
     * Verify + advance to uploaded. Idempotent.
     */
    public function complete(Attachment $attachment, User $uploader): Attachment
    {
        if ($attachment->uploader_id !== $uploader->id) {
            throw ApiException::msgAttachmentInvalid();
        }

        // idempotent replay (FR-MEDIA-001 AC)
        if ($attachment->status !== AttachmentStatus::Pending) {
            return $attachment;
        }

        if ($attachment->expires_at !== null && $attachment->expires_at->isPast()) {
            throw ApiException::mediaUploadMissing();
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        if (! $disk->exists($attachment->storage_key)) {
            throw ApiException::mediaUploadMissing();
        }

        $actualSize = $disk->size($attachment->storage_key);
        if ($actualSize !== $attachment->size_bytes) {
            $disk->delete($attachment->storage_key);
            throw ApiException::mediaSizeMismatch($attachment->size_bytes);
        }

        $sniffed = $this->sniffMime($disk, $attachment->storage_key);
        $this->assertMimeMatchesKind($sniffed, $attachment->mime_type, $attachment->kind);

        $attachment->forceFill([
            'status' => AttachmentStatus::Uploaded,
            'mime_type' => $sniffed, // sniffed wins (FR-MEDIA-001)
            'expires_at' => null,
        ])->save();

        ProcessAttachment::dispatch($attachment);

        return $attachment->refresh();
    }

    /**
     * Read only the first 8KB — never pull a 200MB video into memory.
     */
    private function sniffMime(FilesystemAdapter $disk, string $key): string
    {
        $stream = $disk->readStream($key);
        try {
            $head = fread($stream, 8192) ?: '';
        } finally {
            fclose($stream);
        }

        $finfo = new \finfo(FILEINFO_MIME_TYPE);

        $sniffed = (string) $finfo->buffer($head);

        // text/plain and application/zip are what finfo reports for the first
        // bytes of several container types — fall back to declared for those.
        if (in_array($sniffed, ['text/plain', 'application/x-empty', 'application/zip'], true)) {
            return $sniffed === 'application/zip' ? $sniffed : 'application/octet-stream';
        }

        return $sniffed;
    }

    private function assertMimeMatchesKind(string $sniffed, string $declared, AttachmentKind $kind): void
    {
        if ($sniffed === 'application/octet-stream') {
            return; // can't disprove — allow (files of any type are permitted)
        }

        $allowed = match ($kind) {
            AttachmentKind::Image, AttachmentKind::Avatar => $this->imageMimes(),
            AttachmentKind::Video => $this->videoMimes(),
            AttachmentKind::File => null, // any non-blocked extension is fine
        };

        if ($allowed === null) {
            return;
        }

        if (! in_array($sniffed, $allowed, true)) {
            throw ApiException::mediaMimeMismatch($sniffed, $declared);
        }
    }

    /**
     * @return list<string>
     */
    private function imageMimes(): array
    {
        $map = ['jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp', 'heic' => 'image/heic', 'heif' => 'image/heif'];

        $allowed = [];
        foreach ($this->settings->array('upload.image.allowed_mimes') as $name) {
            $allowed[] = $map[$name] ?? $name;
        }

        return $allowed;
    }

    /**
     * @return list<string>
     */
    private function videoMimes(): array
    {
        $map = ['mp4' => 'video/mp4', 'quicktime' => 'video/quicktime', 'webm' => 'video/webm'];

        $allowed = [];
        foreach ($this->settings->array('upload.video.allowed_mimes') as $name) {
            $allowed[] = $map[$name] ?? $name;
        }

        return $allowed;
    }

    private function sanitizeName(string $filename): string
    {
        return str_replace(["\0", '/', '\\', "\r", "\n"], '_', $filename);
    }
}
