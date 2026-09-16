<?php

namespace App\Domain\Media;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Exceptions\ApiException;
use App\Jobs\ProcessAttachment;
use App\Models\Attachment;
use App\Models\PublicChatRoom;
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

    /**
     * FR-PCHAT-020 — chat + file + video only. 'avatar' is an account-level
     * artefact with no meaning in a support conversation, and a visitor has no
     * account to attach one to; the visitor request layer rejects it first
     * (API-213) and this is the second of the two deliberate layers.
     */
    private const PUBLIC_CHAT_KINDS = ['image', 'video', 'file'];

    public function __construct(
        private readonly SettingsService $settings,
    ) {}

    /**
     * @param  array{kind: string, filename: string, mime_type: string, size_bytes: int, sha256?: ?string}  $input
     * @return array{0: Attachment, 1: ?string, 2: ?array{upload_id: string, part_size: int, part_urls: list<string>}}
     *                                                                                                                 [attachment, put_url (null when multipart), multipart session (null when single PUT)]
     */
    public function create(User $uploader, string $workspaceId, array $input): array
    {
        $kind = $input['kind'];
        if (! in_array($kind, self::KINDS, true)) {
            throw new ApiException('VALIDATION_FAILED', 'kind ไม่ถูกต้อง', 422, [
                'fields' => ['kind' => ['ต้องเป็น image, video, file หรือ avatar']],
            ]);
        }

        return $this->issue(AttachmentKind::from($kind), $workspaceId, $uploader->id, null, $input);
    }

    /**
     * FR-PCHAT-020 / DEC-068 — the visitor + agent sibling of create().
     *
     * A SIBLING, never a widening of create(User $uploader, ...): every internal
     * caller depends on that non-nullable contract, and relaxing it would push a
     * nullable uploader through the whole internal media path. The deny list,
     * the per-kind size caps and (in completeForPublicChat) the mime sniffing
     * are the SAME code, because the shared code is the security code and a fork
     * would drift in exactly the checks that matter.
     *
     * DEC-072 — the ONE validation difference is a strictly stricter one, and it
     * is keyed off public_chat_room_id inside issue()/finish() rather than off
     * the entry point: this unauthenticated surface additionally refuses the
     * markup family (svg/xml/xhtml/xslt) that FR-MEDIA-004/005 deliberately
     * permit internally. Public chat never promised SVG sharing; internal did.
     *
     * $uploader is NULL for a visitor ticket (API-213) and the agent for an
     * API-225 ticket; public_chat_room_id is set either way and is what makes
     * the row claimable only by a message in THIS conversation.
     *
     * @param  array{kind: string, filename: string, mime_type: string, size_bytes: int, sha256?: ?string}  $input
     * @return array{0: Attachment, 1: ?string, 2: ?array{upload_id: string, part_size: int, part_urls: list<string>}}
     */
    public function createForPublicChat(PublicChatRoom $room, array $input, ?User $uploader = null): array
    {
        $kind = $input['kind'];
        if (! in_array($kind, self::PUBLIC_CHAT_KINDS, true)) {
            throw new ApiException('VALIDATION_FAILED', 'kind ไม่ถูกต้อง', 422, [
                'fields' => ['kind' => ['ต้องเป็น image, video หรือ file']],
            ]);
        }

        return $this->issue(
            AttachmentKind::from($kind),
            $room->workspace_id,
            $uploader?->id,
            $room->id,
            $input,
        );
    }

    /**
     * The shared ticket minting used by BOTH create() and createForPublicChat():
     * extension deny list, per-kind size cap, row, presigned PUT or multipart
     * session. The ONLY thing the two callers vary is who owns the row.
     *
     * @param  array{kind: string, filename: string, mime_type: string, size_bytes: int, sha256?: ?string}  $input
     * @return array{0: Attachment, 1: ?string, 2: ?array{upload_id: string, part_size: int, part_urls: list<string>}}
     */
    private function issue(
        AttachmentKind $attachmentKind,
        string $workspaceId,
        ?string $uploaderId,
        ?string $publicChatRoomId,
        array $input,
    ): array {
        // DEC-072 layer 1. `pathinfo` alone is not enough: Windows and several
        // object stores strip trailing dots and spaces, so "evil.html " and
        // "evil.html." both land as evil.html but compare unequal to 'html'
        // here. Normalise before the deny list, never after.
        $extension = InlineSafety::normalizeExtension($input['filename']);
        $blocked = $this->settings->array('upload.file.blocked_extensions');
        if ($extension !== '' && in_array($extension, $blocked, true)) {
            throw ApiException::mediaTypeBlocked($extension);
        }

        // DEC-072 — the PUBLIC CHAT surface refuses the whole markup family by
        // name on top of the settings list. Internal uploads do NOT: FR-MEDIA-
        // 004/005 specify that SVG is accepted and served as an attachment, and
        // the forced read-time disposition (MediaUrls / UploadController::file)
        // is what makes that safe — including for objects stored long before
        // any of these upload checks existed.
        //
        // The public-chat list is a constant rather than a setting so that an
        // admin narrowing upload.file.blocked_extensions cannot reopen the
        // unauthenticated surface.
        $isPublicChat = $publicChatRoomId !== null;
        if ($isPublicChat && InlineSafety::isPublicChatBlockedExtension($extension)) {
            throw ApiException::mediaTypeBlocked($extension);
        }

        // DEC-072 layer 2a — refuse a browser-executable type the client
        // DECLARES, before any object exists. This is the cheap half of the mime
        // defence: the declared value is attacker-controlled and proves nothing,
        // but rejecting it here means the honest-but-wrong client fails at
        // ticket time with a clear error instead of after a 100MB PUT, and the
        // dishonest one still has to get past the SNIFF in finish(), which is
        // the half that actually holds.
        //
        // DEC-072: which deny list depends on the surface. isBrowserExecutable()
        // is the public-chat question (floor + markup); isAlwaysBlockedMime() is
        // the floor every surface enforces — text/html, PHP, script sources,
        // Flash, whole-page archives.
        $mimeBlocked = $isPublicChat
            ? InlineSafety::isBrowserExecutable($input['mime_type'])
            : InlineSafety::isAlwaysBlockedMime($input['mime_type']);

        if ($mimeBlocked) {
            throw ApiException::mediaMimeMismatch($input['mime_type'], $input['mime_type']);
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
            'uploader_id' => $uploaderId,
            'public_chat_room_id' => $publicChatRoomId,
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

        // TASK-BE-024 — S3 + >50MB ⇒ multipart session instead of one PUT
        $threshold = $this->settings->int('upload.multipart_threshold_bytes');
        if ($input['size_bytes'] > $threshold && S3Multipart::supports($disk)) {
            $partBytes = $this->settings->int('upload.multipart_part_bytes');
            $session = (new S3Multipart)->begin($disk, $storageKey, $input['size_bytes'], $partBytes);

            if (count($session['part_urls']) > S3Multipart::MAX_PARTS) {
                (new S3Multipart)->abort($disk, $storageKey, $session['upload_id']);
                $attachment->delete();

                throw ApiException::mediaTooLarge($maxBytes);
            }

            $attachment->forceFill([
                'multipart_upload_id' => $session['upload_id'],
                'multipart_part_bytes' => $partBytes,
            ])->save();

            return [$attachment, null, [
                'upload_id' => $session['upload_id'],
                'part_size' => $partBytes,
                'part_urls' => $session['part_urls'],
            ]];
        }

        $putUrl = $disk->temporaryUploadUrl($storageKey, now()->addMinutes(15))['url'];

        return [$attachment, $putUrl, null];
    }

    /**
     * Verify + advance to uploaded. Idempotent. $parts carries the client's
     * {part_number, etag} list for multipart sessions (TASK-BE-024).
     *
     * @param  list<array{part_number: int, etag: string}>|null  $parts
     */
    public function complete(Attachment $attachment, User $uploader, ?array $parts = null): Attachment
    {
        if ($attachment->uploader_id !== $uploader->id) {
            throw ApiException::msgAttachmentInvalid();
        }

        return $this->finish($attachment, $parts);
    }

    /**
     * FR-PCHAT-020 / DEC-068 — the sibling of complete() for a public chat
     * ticket.
     *
     * The ownership test is ROOM-scoped, never uploader-scoped: a visitor upload
     * has uploader_id NULL by design, so "is this yours?" has no meaning and
     * complete()'s identity check can never be satisfied. The partition column
     * IS the ownership test, and workspace_id is asserted alongside it as
     * defence in depth so a guessed ULID from another tenant cannot be completed
     * even if the two columns ever disagreed.
     *
     * Everything past this point — the expiry check, the multipart assembly, the
     * HEAD size comparison and the finfo mime sniff — is the SAME code complete()
     * runs, deliberately not forked.
     *
     * @param  list<array{part_number: int, etag: string}>|null  $parts
     */
    public function completeForPublicChat(Attachment $attachment, PublicChatRoom $room, ?array $parts = null): Attachment
    {
        if ($attachment->public_chat_room_id === null
            || $attachment->public_chat_room_id !== $room->id
            || $attachment->workspace_id !== $room->workspace_id) {
            throw ApiException::msgAttachmentInvalid();
        }

        return $this->finish($attachment, $parts);
    }

    /**
     * The shared verification tail of complete() and completeForPublicChat():
     * idempotent replay, expiry, multipart assembly, size match, mime sniff,
     * then ProcessAttachment. Ownership is the caller's business; everything
     * here is the security check set both sides must run identically.
     *
     * @param  list<array{part_number: int, etag: string}>|null  $parts
     */
    private function finish(Attachment $attachment, ?array $parts = null): Attachment
    {
        // idempotent replay (FR-MEDIA-001 AC)
        if ($attachment->status !== AttachmentStatus::Pending) {
            return $attachment;
        }

        if ($attachment->expires_at !== null && $attachment->expires_at->isPast()) {
            throw ApiException::mediaUploadMissing();
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        if ($attachment->multipart_upload_id !== null) {
            if ($parts === null || $parts === []) {
                throw new ApiException('VALIDATION_FAILED', 'ต้องระบุ parts สำหรับอัปโหลดแบบ multipart', 422, [
                    'fields' => ['parts' => ['ต้องส่งรายการ {part_number, etag} ของทุก part']],
                ]);
            }

            (new S3Multipart)->complete($disk, $attachment->storage_key, $attachment->multipart_upload_id, $parts);
        }

        if (! $disk->exists($attachment->storage_key)) {
            throw ApiException::mediaUploadMissing();
        }

        $actualSize = $disk->size($attachment->storage_key);
        if ($actualSize !== $attachment->size_bytes) {
            $disk->delete($attachment->storage_key);
            throw ApiException::mediaSizeMismatch($attachment->size_bytes);
        }

        $sniffed = $this->sniffMime($disk, $attachment->storage_key);
        // DEC-072 — the surface is read off the ROW, never off which entry point
        // called us. An agent's public-chat ticket carries the agent as
        // uploader_id, so that agent can legitimately reach the INTERNAL
        // complete() endpoint with it and satisfy its ownership check; the
        // public_chat_room_id column is the only thing that still tells the
        // truth about where those bytes will be shown.
        $this->assertMimeMatchesKind(
            $sniffed,
            $attachment->mime_type,
            $attachment->kind,
            $attachment->public_chat_room_id !== null,
        );

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

    /**
     * DEC-072 layer 2b — THE LAYER A RENAME CANNOT LIE TO.
     *
     * `$sniffed` comes from libmagic over the bytes that actually landed, so
     * unlike the extension deny list and the declared mime it cannot be talked
     * out of the truth. The deny list therefore runs FIRST and for EVERY kind,
     * including File, which previously returned `null` here and meant "kind=file
     * has no mime allowlist at all" — the hole that let `payload.txt` carrying
     * `<html><script>` through, get its sniffed `text/html` written back onto
     * the row as the authoritative mime_type, and then be replayed inline by
     * MinIO on our own origin.
     *
     * NOTE the ordering against application/octet-stream: the deny list is
     * checked BEFORE that early return, not after. The return is "we could not
     * identify these bytes, and a file of any type is permitted" — it must never
     * become "we DID identify these bytes as text/html but gave up anyway".
     *
     * Image and Video keep their existing positive allowlists untouched; this
     * only ever removes reach, never adds it.
     *
     * DEC-072 — $publicChat picks WHICH deny list. On the unauthenticated public
     * chat surface it is the full browser-executable set, so sniffed SVG or XML
     * behind an innocent .dat name is refused. Internally it is the floor only:
     * markup is specced to be accepted (FR-MEDIA-004/005) and is made inert at
     * READ time instead, which is the layer that also covers everything already
     * in the bucket. text/html is on the floor and is refused on both.
     */
    private function assertMimeMatchesKind(string $sniffed, string $declared, AttachmentKind $kind, bool $publicChat = false): void
    {
        $blocked = $publicChat
            ? InlineSafety::isBrowserExecutable($sniffed)
            : InlineSafety::isAlwaysBlockedMime($sniffed);

        if ($blocked) {
            throw ApiException::mediaMimeMismatch($sniffed, $declared);
        }

        if ($sniffed === 'application/octet-stream') {
            return; // can't disprove — allow (files of any type are permitted)
        }

        $allowed = match ($kind) {
            AttachmentKind::Image, AttachmentKind::Avatar => $this->imageMimes(),
            AttachmentKind::Video => $this->videoMimes(),
            AttachmentKind::File => null, // any non-blocked, non-executable type
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
