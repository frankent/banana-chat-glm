<?php

namespace App\Domain\Media;

use Symfony\Component\Process\Process;

/**
 * FR-MEDIA-004 video pipeline (closes DEC-034). On the full-profile
 * container ffmpeg/ffprobe ship with the image; host dev boxes without
 * them keep the lite behavior (video → ready, no poster/metadata) — every
 * method degrades to null/false instead of throwing.
 */
class Ffmpeg
{
    public function __construct(
        private readonly string $ffmpegPath,
        private readonly string $ffprobePath,
        private readonly int $timeout,
    ) {}

    public static function fromConfig(): self
    {
        return new self(
            (string) config('services.ffmpeg.binary', 'ffmpeg'),
            (string) config('services.ffmpeg.probe_binary', 'ffprobe'),
            (int) config('services.ffmpeg.timeout', 120),
        );
    }

    public function available(): bool
    {
        return $this->binaryWorks($this->ffmpegPath) && $this->binaryWorks($this->ffprobePath);
    }

    /**
     * @return array{width: int, height: int, duration_ms: int}|null
     */
    public function probe(string $localPath): ?array
    {
        $proc = new Process([$this->ffprobePath, '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', $localPath]);
        $proc->setTimeout($this->timeout)->run();
        if (! $proc->isSuccessful()) {
            return null;
        }

        $json = json_decode($proc->getOutput(), true);
        $stream = collect($json['streams'] ?? [])->first(fn ($s) => ($s['codec_type'] ?? '') === 'video');
        if ($stream === null) {
            return null;
        }

        $durationSeconds = (float) ($json['format']['duration'] ?? $stream['duration'] ?? 0);

        return [
            'width' => (int) ($stream['width'] ?? 0),
            'height' => (int) ($stream['height'] ?? 0),
            'duration_ms' => (int) round($durationSeconds * 1000),
        ];
    }

    /**
     * Extract one frame near $atSec as PNG bytes for the GD thumb pipeline
     * (re-encode keeps posters EXIF-free, same as image thumbs).
     */
    public function posterFrame(string $localPath, float $atSec = 1.0): ?string
    {
        $out = tempnam(sys_get_temp_dir(), 'poster');
        if ($out === false) {
            return null;
        }

        try {
            $proc = new Process([
                $this->ffmpegPath, '-loglevel', 'error', '-ss', (string) $atSec,
                '-i', $localPath, '-frames:v', '1', '-f', 'image2', '-y', $out,
            ]);
            $proc->setTimeout($this->timeout)->run();
            if (! $proc->isSuccessful()) {
                return null;
            }

            $bytes = @file_get_contents($out);

            return $bytes === false || $bytes === '' ? null : $bytes;
        } finally {
            @unlink($out);
        }
    }

    private function binaryWorks(string $binary): bool
    {
        $resolved = realpath($binary);
        if ($resolved !== false) {
            return is_executable($resolved);
        }

        // PATH lookup (name, not a path)
        $proc = new Process(['command', '-v', $binary]);
        $proc->setTimeout(5)->run();

        return $proc->isSuccessful() && is_executable(trim($proc->getOutput()));
    }
}
