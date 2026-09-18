<?php

namespace App\Domain\Ai;

/**
 * FR-AI-019 — incremental SSE parser for OpenAI-compatible streams.
 * Survives multi-line `data:` events, `\r\n` line endings and chunks
 * cut mid-line. Feed it raw body chunks; it yields decoded payloads.
 */
class SseParser
{
    /** Key the decoded payload carries its `event:` name under. */
    public const EVENT_KEY = '__event';

    private string $buffer = '';

    private string $eventName = '';

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

            // `event:` names the payload on the next `data:` line. Plain chat
            // completions never send one; an agent backend uses it to report
            // what it is doing (hermes.tool.progress), and telling those apart
            // by guessing at the payload's keys breaks the day it adds another.
            if (str_starts_with($line, 'event:')) {
                $this->eventName = trim(substr($line, 6));

                continue;
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
                if ($this->eventName !== '') {
                    $decoded[self::EVENT_KEY] = $this->eventName;
                }
                $events[] = $decoded;
            }
            $this->eventName = '';
        }

        return $events;
    }

    public function isDone(): bool
    {
        return $this->done;
    }
}
