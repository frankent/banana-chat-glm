/** FR-MSG-012 — local reaction UI copy (Thai is the default). */
export const reactionsText = {
  th: {
    react: 'เพิ่มรีแอ็กชัน', picker: 'เลือกอีโมจิ', search: 'ค้นหาอีโมจิ', recent: 'ใช้ล่าสุด',
    all: 'ทั้งหมด', close: 'ปิด', whoReacted: 'ผู้ที่รีแอ็กชัน', reactorsTitle: 'ผู้ที่รีแอ็กชัน', reactorTabOne: '{emoji} {count} คน', reactorTabMany: '{emoji} {count} คน', loading: 'กำลังโหลดผู้ที่รีแอ็กชัน…',
    failed: 'โหลดผู้ที่รีแอ็กชันไม่สำเร็จ', retry: 'ลองอีกครั้ง', noUsers: 'ยังไม่มีผู้รีแอ็กชัน',
    reactionFailed: 'ส่งรีแอ็กชันไม่สำเร็จ ลองอีกครั้ง', limit: 'ข้อความนี้มีรีแอ็กชันครบแล้ว',
    people: 'ดูผู้ที่รีแอ็กชันด้วย {emoji}', selected: 'เลือก {emoji}',
    chipLabel: '{emoji} {count} คน — กดเพื่อรีแอ็กชัน, กด Shift+F10 เพื่อดูผู้ที่รีแอ็กชัน', chipOwnLabel: '{emoji} {count} คน — กดเพื่อเอารีแอ็กชันออก, กด Shift+F10 เพื่อดูผู้ที่รีแอ็กชัน',
  },
  en: {
    react: 'Add reaction', picker: 'Choose an emoji', search: 'Search emoji', recent: 'Recent',
    all: 'All', close: 'Close', whoReacted: 'Who reacted', reactorsTitle: 'People who reacted', reactorTabOne: '{emoji}, {count} reaction', reactorTabMany: '{emoji}, {count} reactions', loading: 'Loading people who reacted…',
    failed: 'Could not load people who reacted', retry: 'Try again', noUsers: 'No one has reacted yet',
    reactionFailed: 'Could not send reaction. Try again.', limit: 'This message has the maximum number of reactions',
    people: 'See who reacted with {emoji}', selected: 'Select {emoji}',
    chipLabel: '{emoji} {count} {reactionWord} — press to react, press Shift+F10 to see who reacted', chipOwnLabel: '{emoji} {count} {reactionWord} — press to remove your reaction, press Shift+F10 to see who reacted',
  },
} as const;
export type ReactionsTextKey = keyof typeof reactionsText.th;
