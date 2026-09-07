<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Media\AttachmentSerializer;
use App\Domain\Media\UploadService;
use App\Enums\AttachmentStatus;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Models\Attachment;
use App\Support\WorkspaceContext;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * API-060/061/062 — presigned upload flow (FR-MEDIA-001/004).
 *
 * Route params resolve in-controller (like rooms): implicit binding runs
 * before workspace.context, so binding here would leak cross-workspace rows.
 */
class UploadController extends Controller
{
    public function __construct(
        private readonly UploadService $uploads,
        private readonly AttachmentSerializer $serializer,
        private readonly WorkspaceContext $context,
    ) {}

    /**
     * API-060 — create attachment + presigned PUT (15 min).
     */
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'kind' => ['required', 'string'],
            'filename' => ['required', 'string', 'max:255'],
            'mime_type' => ['required', 'string', 'max:127'],
            'size_bytes' => ['required', 'integer', 'min:1'],
            'sha256' => ['nullable', 'string'],
        ]);

        [$attachment, $putUrl, $multipart] = $this->uploads->create(
            $request->user(),
            (string) $this->context->id(),
            $data,
        );

        return response()->json([
            'data' => [
                'attachment_id' => $attachment->id,
                'put_url' => $putUrl,
                // TASK-BE-024 — present only for S3 multipart (>50MB)
                'multipart' => $multipart,
                'headers' => [
                    'Content-Type' => 'application/octet-stream',
                ],
                'expires_at' => now()->addMinutes(15)->toIso8601String(),
            ],
        ], 201);
    }

    /**
     * API-061 — verify the PUT landed, advance to uploaded (idempotent).
     */
    public function complete(Request $request, string $attachmentId): JsonResponse
    {
        // pending rows resolve via the scoped query too (scope active here)
        $attachment = Attachment::query()->findOrFail($attachmentId);

        $parts = $request->input('parts'); // multipart sessions only (TASK-BE-024)

        $attachment = $this->uploads->complete($attachment, $request->user(), is_array($parts) ? $parts : null);

        return response()->json([
            'data' => ['attachment' => $this->serializer->toArray($attachment)],
        ]);
    }

    /**
     * API-062 — fresh signed GET URLs (FR-MEDIA-004).
     */
    public function show(Request $request, string $attachmentId): JsonResponse
    {
        $attachment = $this->findOrFail($attachmentId);

        return response()->json([
            'data' => ['attachment' => $this->serializer->toArray($attachment)],
        ]);
    }

    /**
     * Local-disk upload sink — the `put_url` when FILESYSTEM_DISK=local.
     * Signature-checked only (possession of the 15-min URL = authorization,
     * same trust model as an S3 presigned PUT).
     */
    public function binary(Request $request, string $attachmentId): JsonResponse
    {
        $attachment = Attachment::withoutGlobalScopes()->findOrFail($attachmentId);

        if ($attachment->status !== AttachmentStatus::Pending || ($attachment->expires_at?->isPast() ?? false)) {
            throw ApiException::mediaUploadMissing();
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        $disk->put($attachment->storage_key, $request->getContent(), 'private');

        return response()->json(['data' => ['stored' => true]]);
    }

    /**
     * Local-disk file stream — the signed `urls.*` when FILESYSTEM_DISK=local.
     * SVG is never served inline (XSS, FR-MEDIA-004).
     */
    public function file(Request $request, string $attachmentId, string $variant): StreamedResponse
    {
        $attachment = Attachment::withoutGlobalScopes()->findOrFail($attachmentId);

        $key = $variant === 'original'
            ? $attachment->storage_key
            : ($attachment->derived ?? [])[$variant] ?? null;
        if ($key === null) {
            abort(404);
        }

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));
        if (! $disk->exists($key)) {
            abort(404);
        }

        $mime = $variant === 'original' ? $attachment->mime_type : 'image/webp';
        $disposition = str_contains($mime, 'svg') ? 'attachment' : 'inline';

        return $disk->response($key, $attachment->original_name, [
            'Content-Type' => $mime,
            'Content-Disposition' => $disposition.'; filename="'.str_replace('"', '', $attachment->original_name).'"',
            'X-Content-Type-Options' => 'nosniff',
        ]);
    }

    /**
     * Workspace-soped resolution — the global scope is active here because
     * workspace.context middleware ran, so cross-ws ids 404.
     */
    private function findOrFail(string $attachmentId): Attachment
    {
        return Attachment::query()
            ->whereNot('status', AttachmentStatus::Pending->value)
            ->findOrFail($attachmentId);
    }
}
