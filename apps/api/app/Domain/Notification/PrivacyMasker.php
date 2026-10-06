<?php

namespace App\Domain\Notification;

/**
 * FR-NOTI-008 / DEC-087 — the one place that knows what a notification says
 * when the RECIPIENT has privacy_mode on. Every server-side builder of a
 * user-facing notification (PushDecisionService::payload, NotifyPublicChatMessage,
 * InAppNotification creators) must route through here instead of inventing its
 * own generic line, so the wording cannot drift between surfaces.
 *
 * The client renders the same strings for its own in-app surfaces; the wire
 * contract (contract note in DEC-087) pins th|en.
 */
class PrivacyMasker
{
    public const TITLE = 'Banana Chat';

    /** @var array<string, array<string, string>> */
    private const BODIES = [
        'th' => [
            'message' => 'ข้อความใหม่',
            'photo' => 'รูปภาพใหม่',
            'video' => 'วิดีโอใหม่',
            'file' => 'ไฟล์ใหม่',
            'call' => 'สายเรียกเข้า',
            'missed_call' => 'สายที่ไม่ได้รับ',
            'mention' => 'มีการกล่าวถึงคุณ',
        ],
        'en' => [
            'message' => 'New message',
            'photo' => 'New photo',
            'video' => 'New video',
            'file' => 'New file',
            'call' => 'Incoming call',
            'missed_call' => 'Missed call',
            'mention' => 'You were mentioned',
        ],
    ];

    /**
     * Generic body line by kind, in the recipient's locale (th default —
     * `users.locale` is constrained to th|en). Unknown kinds fall back to the
     * message line: a generic-but-vague notification is the safe failure.
     */
    public function body(string $kind, ?string $locale): string
    {
        return self::BODIES[$locale === 'en' ? 'en' : 'th'][$kind]
            ?? self::BODIES[$locale === 'en' ? 'en' : 'th']['message'];
    }

    public function title(): string
    {
        return self::TITLE;
    }

    /**
     * Is the privacy flag on for this settings row? Null-safe helper so
     * callers with a missing settings row read it as off.
     */
    public function enabled(?bool $privacyMode): bool
    {
        return $privacyMode ?? false;
    }
}
