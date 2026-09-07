<?php

namespace App\Domain\Media;

/**
 * FR-MEDIA-006 — ClamAV daemon (clamd) client using the INSTREAM protocol.
 *
 * Streams the object bytes over TCP in ≤64KB chunks, so a 100MB file never
 * lands in worker memory. Returns null when the daemon is unreachable or
 * scanning is disabled — callers treat that as `skipped` (TC-MEDIA-034),
 * never as an upload failure.
 */
class ClamAvScanner
{
    private const CHUNK_SIZE = 65536;

    public function __construct(
        private readonly string $host,
        private readonly int $port,
        private readonly int $timeout,
        private readonly bool $enabled,
    ) {}

    public static function fromConfig(): self
    {
        return new self(
            (string) config('services.clamav.host', 'clamav'),
            (int) config('services.clamav.port', 3310),
            (int) config('services.clamav.timeout', 30),
            (bool) config('services.clamav.enabled', true),
        );
    }

    /**
     * @param  resource  $stream  binary stream of the object to scan
     * @return bool|null true = clean, false = infected, null = unavailable/disabled
     */
    public function scanStream($stream): ?bool
    {
        if (! $this->enabled) {
            return null;
        }

        $socket = @fsockopen($this->host, $this->port, $errno, $errstr, $this->timeout);
        if ($socket === false) {
            return null;
        }

        try {
            fwrite($socket, "zINSTREAM\0");

            while (! feof($stream)) {
                $chunk = fread($stream, self::CHUNK_SIZE);
                if ($chunk === false || $chunk === '') {
                    break;
                }
                fwrite($socket, pack('N', strlen($chunk)).$chunk);
            }
            fwrite($socket, pack('N', 0));

            $response = '';
            while (($line = fgets($socket, 1024)) !== false) {
                $response .= $line;
                if (str_contains($response, "\0")) {
                    break;
                }
            }

            if (trim($response) === '') {
                return null; // daemon closed without a verdict — treat as skipped
            }

            return ! str_contains($response, 'FOUND');
        } finally {
            fclose($socket);
        }
    }

    public function scan(string $bytes): ?bool
    {
        $stream = fopen('php://memory', 'r+');
        fwrite($stream, $bytes);
        rewind($stream);

        try {
            return $this->scanStream($stream);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }
}
