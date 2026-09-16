<?php

namespace App\Enums;

/**
 * FR-PCHAT-001 — the INTERNAL status of a public chat room.
 *
 * MANDATORY graft 1 / pinned decision 2: this value is NEVER sent to the
 * visitor. `problem` is an internal triage flag, and a customer discovering
 * that support flagged their conversation as a problem is an information
 * disclosure with a real business cost. Every visitor-facing surface (API-210,
 * the EVT-081 visitor variant) sends `status_public` — the projection below —
 * instead. Tier 1 (API-201) keeps the raw status: the partner owns the ticket,
 * the visitor does not.
 */
enum PublicChatStatus: string
{
    case New = 'new';
    case InProgress = 'in_progress';
    case Done = 'done';
    case Problem = 'problem';

    public const PUBLIC_OPEN = 'open';

    public const PUBLIC_CLOSED = 'closed';

    /**
     * The ONE definition of the visitor-facing projection. new|in_progress|
     * problem => 'open'; done => 'closed'.
     */
    public function public(): string
    {
        return $this === self::Done ? self::PUBLIC_CLOSED : self::PUBLIC_OPEN;
    }

    /** A room in this status accepts visitor and agent writes. */
    public function isOpen(): bool
    {
        return $this !== self::Done;
    }

    /** @return list<string> */
    public static function values(): array
    {
        return array_map(fn (self $c) => $c->value, self::cases());
    }
}
