<?php

namespace App\Domain\Media;

use Aws\S3\S3Client;
use Illuminate\Filesystem\AwsS3V3Adapter;
use Illuminate\Filesystem\FilesystemAdapter;
use RuntimeException;

/**
 * TASK-BE-024 / FR-MEDIA-001 — S3 multipart upload session (files > 50MB).
 *
 * create() hands the client presigned UploadPart URLs (15 min, same trust
 * model as the single-PUT presign); complete() assembles the parts server-
 * side with the ETags the client reports. Local disk has no multipart —
 * UploadService falls back to the single presigned PUT (valid to 200MB).
 */
class S3Multipart
{
    public const MAX_PARTS = 10000; // S3 hard limit

    public static function supports(FilesystemAdapter $disk): bool
    {
        return $disk instanceof AwsS3V3Adapter;
    }

    /** Number of parts a size splits into at the given part size. */
    public static function partCount(int $sizeBytes, int $partBytes): int
    {
        if ($partBytes < 5 * 1024 * 1024) {
            throw new RuntimeException('multipart part size below the 5MB S3 minimum');
        }

        return (int) ceil($sizeBytes / $partBytes);
    }

    /**
     * @return array{upload_id: string, part_urls: list<string>}
     */
    public function begin(FilesystemAdapter $disk, string $key, int $sizeBytes, int $partBytes): array
    {
        $client = $this->client($disk);
        $bucket = $this->bucket($disk);

        $result = $client->createMultipartUpload([
            'Bucket' => $bucket,
            'Key' => $key,
        ]);

        $uploadId = (string) $result['UploadId'];

        $urls = [];
        foreach (range(1, self::partCount($sizeBytes, $partBytes)) as $partNumber) {
            $command = $client->getCommand('UploadPart', [
                'Bucket' => $bucket,
                'Key' => $key,
                'UploadId' => $uploadId,
                'PartNumber' => $partNumber,
            ]);
            $urls[] = (string) $client->createPresignedRequest($command, '+15 minutes')->getUri();
        }

        return ['upload_id' => $uploadId, 'part_urls' => $urls];
    }

    /**
     * @param  list<array{part_number: int, etag: string}>  $parts
     */
    public function complete(FilesystemAdapter $disk, string $key, string $uploadId, array $parts): void
    {
        usort($parts, fn ($a, $b) => $a['part_number'] <=> $b['part_number']);

        $this->client($disk)->completeMultipartUpload([
            'Bucket' => $bucket = $this->bucket($disk),
            'Key' => $key,
            'UploadId' => $uploadId,
            'MultipartUpload' => [
                'Parts' => array_map(fn ($p) => ['PartNumber' => (int) $p['part_number'], 'ETag' => (string) $p['etag']], $parts),
            ],
        ]);
    }

    /** Best-effort — used when purging an abandoned session. */
    public function abort(FilesystemAdapter $disk, string $key, string $uploadId): void
    {
        try {
            $this->client($disk)->abortMultipartUpload([
                'Bucket' => $this->bucket($disk),
                'Key' => $key,
                'UploadId' => $uploadId,
            ]);
        } catch (\Throwable) {
            // orphaned multipart sessions expire server-side anyway
        }
    }

    private function client(FilesystemAdapter $disk): S3Client
    {
        if (! $disk instanceof AwsS3V3Adapter) {
            throw new RuntimeException('multipart requires the s3 disk');
        }

        return $disk->getClient();
    }

    private function bucket(FilesystemAdapter $disk): string
    {
        $config = $disk->getConfig();
        $bucket = $config['bucket'] ?? config('filesystems.disks.s3.bucket');

        if (! is_string($bucket) || $bucket === '') {
            throw new RuntimeException('s3 bucket not configured');
        }

        return $bucket;
    }
}
