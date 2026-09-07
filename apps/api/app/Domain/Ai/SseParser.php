<?php

namespace App\Domain\Ai;

/**
 * FR-AI-019 — incremental SSE parser for OpenAI-compatible streams.
 * Survives multi-line `data:` events, `\r\n` line endings and chunks
 * cut mid-line. Feed it raw body chunks; it yields decoded payloads.
 */
class SseParser
{
    private string $buffer = '';

    private bool $done = false;

    /**
     * @return list<array<string, mixed>> decoded `data:` payloads in order
     */
    public function push(string $chunk): array
    {
        $this->buffer .= $chunk;
        $events = [];

        // normalize CRLF, then split on any remaining newline
        while (($pos = strpos($this->buffer, "\n")) !== false) {
            $line = rtrim(substr($this->buffer, 0, $pos), "\r");
            $this->buffer = substr($this->buffer, $pos + 1);

            if ($line === '' || str_starts_with($line, ':')) {
                continue; // event boundary or comment/ping
            }

            if (! str_starts_with($line, 'data:')) {
                continue;
            }

            $data = ltrim(substr($line, 5));

            if ($data === '[DONE]') {
                $this->done = true;

                break;
            }

            $decoded = json_decode($data, true);
            if (is_array($decoded)) {
                $events[] = $decoded;
            }
        }

        return $events;
    }

    public function isDone(): bool
    {
        return $this->done;
    }
}
