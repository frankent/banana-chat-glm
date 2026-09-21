<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * Carries a spec §7.1 error code through to the {error:{code,message,details,request_id}} envelope.
 */
class ApiException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 422,
        public readonly array $details = [],
        /**
         * Extra response headers. The §7 renderer in bootstrap/app.php applies
         * them verbatim. Added for FR-PCHAT-034 / DEC-067, whose 503 must carry
         * `Retry-After` so a partner's client retries on a schedule instead of
         * hot-looping.
         */
        public readonly array $headers = [],
    ) {
        parent::__construct($message);
    }

    public static function invalidCredentials(): self
    {
        return new self('AUTH_INVALID_CREDENTIALS', 'username หรือรหัสผ่านไม่ถูกต้อง', 401);
    }

    public static function accountDisabled(): self
    {
        return new self('AUTH_ACCOUNT_DISABLED', 'บัญชีนี้ไม่สามารถใช้งานได้', 403);
    }

    public static function locked(int $retryAfterSeconds): self
    {
        return new self('AUTH_LOCKED', 'บัญชีถูกล็อกชั่วคราวจากการพยายามเข้าสู่ระบบหลายครั้ง', 423, [
            'retry_after_seconds' => $retryAfterSeconds,
        ]);
    }

    public static function tokenInvalid(): self
    {
        return new self('AUTH_TOKEN_INVALID', 'token ไม่ถูกต้อง', 401);
    }

    public static function tokenExpired(): self
    {
        return new self('AUTH_TOKEN_EXPIRED', 'token หมดอายุ', 401);
    }

    public static function refreshExpired(): self
    {
        return new self('AUTH_REFRESH_EXPIRED', 'refresh token หมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
    }

    public static function refreshReused(): self
    {
        return new self('AUTH_REFRESH_REUSED', 'refresh token ถูกใช้ซ้ำ ระบบยกเลิก session ทั้งหมดเพื่อความปลอดภัย', 401);
    }

    public static function passwordChangeRequired(): self
    {
        return new self('AUTH_PASSWORD_CHANGE_REQUIRED', 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน', 403);
    }

    public static function usernameTaken(): self
    {
        return new self('AUTH_USERNAME_TAKEN', 'username นี้ถูกใช้แล้ว', 422);
    }

    // ---- Workspace invite (FR-WS-006/FR-AUTH-008, DEC-081, §7.1) ----

    public static function inviteNotFound(): self
    {
        return new self('INVITE_NOT_FOUND', 'ไม่พบคำเชิญนี้', 404);
    }

    public static function inviteExpired(): self
    {
        return new self('INVITE_EXPIRED', 'คำเชิญนี้หมดอายุแล้ว', 410);
    }

    public static function inviteRevoked(): self
    {
        return new self('INVITE_REVOKED', 'คำเชิญนี้ถูกยกเลิกแล้ว', 410);
    }

    public static function inviteAlreadyUsed(): self
    {
        return new self('INVITE_ALREADY_USED', 'คำเชิญนี้ถูกใช้ไปแล้ว', 409);
    }

    // ---- Room errors (FR-ROOM-001..008, §7.1) ----

    public static function roomDmSelf(): self
    {
        return new self('ROOM_DM_SELF', 'ไม่รองรับการสร้าง DM กับตัวเองใน v1', 422);
    }

    public static function roomFull(int $maxMembers): self
    {
        return new self('ROOM_FULL', 'ห้องมีสมาชิกครบตามจำนวนสูงสุดแล้ว', 422, [
            'max_members' => $maxMembers,
        ]);
    }

    public static function roomDmImmutable(): self
    {
        return new self('ROOM_DM_IMMUTABLE', 'DM ไม่สามารถแก้ไขสมาชิกหรือลบได้', 422);
    }

    public static function roomForbidden(): self
    {
        return new self('ROOM_FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้ในห้อง', 403);
    }

    public static function roomNotMember(): self
    {
        return new self('ROOM_NOT_MEMBER', 'คุณไม่ได้เป็นสมาชิกของห้องนี้', 403);
    }

    public static function roomOwnerCannotLeave(): self
    {
        return new self('ROOM_OWNER_CANNOT_LEAVE', 'เจ้าของห้องต้องโอนความเป็นเจ้าของก่อนออกจากห้อง', 422);
    }

    /**
     * FR-ROOM-012 — secret room past its expiry: every read/write/media/call
     * path denies immediately, before the scheduler purges the row.
     */
    public static function roomExpired(?string $expiresAt = null): self
    {
        return new self('ROOM_EXPIRED', 'ห้องลับนี้หมดอายุแล้ว ข้อความและไฟล์ทั้งหมดถูกลบ', 410, [
            'expires_at' => $expiresAt,
        ]);
    }

    // ---- Message errors (FR-MSG-001, §7.1) ----

    public static function msgTooLong(int $maxLength): self
    {
        return new self('MSG_TOO_LONG', 'ข้อความยาวเกินกำหนด', 422, [
            'max_length' => $maxLength,
        ]);
    }

    public static function msgEmpty(): self
    {
        return new self('MSG_EMPTY', 'ข้อความว่างและไม่มีไฟล์แนบ', 422);
    }

    public static function msgReplyInvalid(): self
    {
        return new self('MSG_REPLY_INVALID', 'ข้อความที่ตอบกลับไม่พบในห้องนี้', 422);
    }

    public static function msgAttachmentInvalid(): self
    {
        return new self('MSG_ATTACHMENT_INVALID', 'ไฟล์แนบไม่ถูกต้อง (ไม่ใช่ของคุณ, workspace ไม่ตรง, สถานะไม่พร้อม หรือถูกใช้ไปแล้ว)', 422);
    }

    public static function msgEditWindowExpired(): self
    {
        return new self('MSG_EDIT_WINDOW_EXPIRED', 'พ้นระยะเวลาที่แก้ไขข้อความได้', 422);
    }

    public static function msgNotEditable(): self
    {
        return new self('MSG_NOT_EDITABLE', 'ข้อความนี้แก้ไขไม่ได้ (ข้อความระบบหรือถูกลบไปแล้ว)', 422);
    }

    // ---- Media errors (FR-MEDIA-001, §7.1) ----

    public static function mediaTooLarge(int $maxBytes): self
    {
        return new self('MEDIA_TOO_LARGE', 'ไฟล์ใหญ่เกินกำหนด', 422, [
            'max_bytes' => $maxBytes,
        ]);
    }

    public static function mediaTypeBlocked(string $extension): self
    {
        return new self('MEDIA_TYPE_BLOCKED', 'ประเภทไฟล์นี้ถูกห้ามอัปโหลด', 422, [
            'extension' => $extension,
        ]);
    }

    public static function mediaMimeMismatch(string $sniffed, string $declared): self
    {
        return new self('MEDIA_MIME_MISMATCH', 'ชนิดไฟล์จริงไม่ตรงกับที่แจ้งไว้', 422, [
            'sniffed_mime' => $sniffed,
            'declared_mime' => $declared,
        ]);
    }

    public static function mediaUploadMissing(): self
    {
        return new self('MEDIA_UPLOAD_MISSING', 'ยังไม่พบไฟล์ที่อัปโหลด กรุณา PUT ก่อนเรียก complete', 422);
    }

    public static function mediaSizeMismatch(int $declaredBytes): self
    {
        return new self('MEDIA_SIZE_MISMATCH', 'ขนาดไฟล์ที่อัปโหลดไม่ตรงกับที่แจ้กไว้', 422, [
            'declared_bytes' => $declaredBytes,
        ]);
    }

    /** R1 / API-062 — workspace member without room/uploader/avatar/kanban/public-chat access. */
    public static function mediaForbidden(): self
    {
        return new self('MEDIA_FORBIDDEN', 'คุณไม่มีสิทธิ์เข้าถึงไฟล์นี้', 403);
    }

    // ---- Public Chat: partner HMAC surface (FR-PCHAT-031, §7.1) ----
    //
    // These are thrown by VerifyPublicChatSignature. They exist as ApiExceptions
    // rather than AuthenticationException on purpose: bootstrap/app.php renders
    // AuthenticationException as AUTH_TOKEN_INVALID, which is misleading for a
    // machine client that holds no token and sends no Authorization header.

    /**
     * Header missing or malformed, key_id unknown, key revoked, workspace not
     * active, OR the stored secret could not be decrypted (APP_KEY rotated —
     * MANDATORY graft 8). One code for all of them: an unauthenticated prober
     * must not be able to enumerate which key ids exist.
     */
    public static function apiKeyInvalid(): self
    {
        return new self('API_KEY_INVALID', 'API key ไม่ถูกต้องหรือถูกยกเลิกแล้ว', 401);
    }

    public static function apiSignatureInvalid(): self
    {
        return new self('API_SIGNATURE_INVALID', 'ลายเซ็นคำขอไม่ถูกต้อง', 401);
    }

    /**
     * ±300s window. The response names the observed skew and the server clock so
     * the partner can fix their NTP instead of guessing.
     */
    public static function apiTimestampSkew(int $skewSeconds): self
    {
        return new self('API_TIMESTAMP_SKEW', 'เวลาของคำขอคลาดเคลื่อนเกินกำหนด', 401, [
            'skew_seconds' => $skewSeconds,
            'max_skew_seconds' => 300,
            'server_time' => now()->getTimestamp(),
        ]);
    }

    public static function apiNonceReplayed(): self
    {
        return new self('API_NONCE_REPLAYED', 'nonce นี้ถูกใช้ไปแล้ว', 409);
    }

    // ---- Public Chat: feature + room lifecycle (FR-PCHAT-034/012, §7.1) ----

    /**
     * FR-PCHAT-034 / DEC-067 — the kill switch. Writes stop; reads and data
     * survive. Thrown only AFTER credentials verify, so a partner can tell
     * "your key is bad" from "the service is paused".
     */
    public static function pchatDisabled(): self
    {
        return new self('PCHAT_DISABLED', 'ระบบแชทสาธารณะถูกปิดใช้งานชั่วคราว', 503, [
            'retry_after_seconds' => 60,
        ], ['Retry-After' => '60']);
    }

    public static function pchatRoomNotFound(): self
    {
        return new self('PCHAT_ROOM_NOT_FOUND', 'ไม่พบห้องแชทสาธารณะนี้', 404);
    }

    public static function pchatRoomClosed(): self
    {
        return new self('PCHAT_ROOM_CLOSED', 'การสนทนานี้ปิดแล้ว', 409);
    }

    /**
     * FR-PCHAT-012 / DEC-063 — past expires_at, or the link was rotated, or the
     * room was soft-deleted. EVERY Tier-2 route including broadcasting/auth
     * answers this, so an open socket cannot outlive the link.
     */
    public static function pchatLinkExpired(?string $expiresAt = null): self
    {
        return new self('PCHAT_LINK_EXPIRED', 'ลิงก์สนทนานี้หมดอายุแล้ว', 410, [
            'expires_at' => $expiresAt,
        ]);
    }

    /**
     * API-224 — the sole state-consistency guard (MANDATORY graft 28): a room
     * cannot leave 'new' with a null assignee, and cannot be unassigned while
     * 'in_progress'.
     */
    public static function pchatInvalidTransition(?string $from = null, ?string $to = null): self
    {
        return new self('PCHAT_INVALID_TRANSITION', 'เปลี่ยนสถานะห้องแบบนี้ไม่ได้', 422, array_filter([
            'from' => $from,
            'to' => $to,
        ], fn ($v) => $v !== null));
    }

    /**
     * FR-PCHAT-013 / MANDATORY graft 18 / pinned decision 3 — a signed-in member
     * opened the customer link. Reads are served as the visitor; WRITES ARE NOT.
     * ApiClient attaches the agent's bearer to every request, so without this an
     * agent checking on a conversation would post a message recorded as coming
     * from the customer. An invalid or expired bearer is a 401 instead — never
     * silently anonymous.
     */
    public static function pchatSignedIn(): self
    {
        return new self('PCHAT_SIGNED_IN', 'คุณกำลังเข้าสู่ระบบอยู่ — เปิดห้องนี้จากเมนู Public Chat แทน', 403);
    }
}
