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
}
