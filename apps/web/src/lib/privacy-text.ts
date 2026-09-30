/** FR-NOTI-008/009: local UI strings; notification payload strings live in chat-core. */
export const privacyText = {
  th: {
    title: 'โหมดส่วนตัว', description: 'ซ่อนเนื้อหาการแจ้งเตือน และใส่รหัสผ่านทุกครั้งที่เปิดแอป',
    heading: 'ใส่รหัสผ่านเพื่อเปิดแชท', hint: 'แชทของคุณถูกล็อกไว้ ใส่รหัสผ่านบัญชีเพื่อกลับไปคุยต่อ',
    password: 'รหัสผ่าน', show: 'แสดงรหัสผ่าน', hide: 'ซ่อนรหัสผ่าน', unlock: 'ปลดล็อก', unlocking: 'กำลังปลดล็อก…',
    logout: 'ออกจากระบบ', forgot: 'ลืมรหัสผ่าน? ออกจากระบบแล้วติดต่อผู้ดูแล',
    invalid: 'รหัสผ่านไม่ถูกต้อง', limited: 'ลองบ่อยเกินไป รอสักครู่', network: 'เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง',
    failed: 'ปลดล็อกไม่สำเร็จ กรุณาลองอีกครั้ง', expired: 'เซสชันหมดอายุ กรุณาออกจากระบบแล้วเข้าสู่ระบบอีกครั้ง',
    saving: 'กำลังบันทึก…', saveError: 'บันทึกโหมดส่วนตัวไม่สำเร็จ กรุณาลองอีกครั้ง',
  },
  en: {
    title: 'Privacy mode', description: 'Hide notification content and ask for your password every time you open the app.',
    heading: 'Enter your password to open chat', hint: 'Your chats are locked. Enter your account password to pick up where you left off.',
    password: 'Password', show: 'Show password', hide: 'Hide password', unlock: 'Unlock', unlocking: 'Unlocking…',
    logout: 'Sign out', forgot: 'Forgot your password? Sign out and contact your administrator.',
    invalid: 'Incorrect password', limited: 'Too many attempts. Please wait a moment.', network: 'Could not connect. Please try again.',
    failed: 'Could not unlock. Please try again.', expired: 'Your session has expired. Please sign out and sign in again.',
    saving: 'Saving…', saveError: 'Could not save privacy mode. Please try again.',
  },
} as const;
