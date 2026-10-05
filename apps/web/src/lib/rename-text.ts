/** FR-ROOM-007 / DEC-092 — rename-group dialog strings (local, like avatar-text). */
export const renameText = {
  th: {
    menu: 'เปลี่ยนชื่อกลุ่ม',
    title: 'เปลี่ยนชื่อกลุ่ม',
    subtitle: 'สมาชิกทุกคนในกลุ่มจะเห็นชื่อใหม่ในรายการแชทและหัวข้อห้อง',
    label: 'ชื่อกลุ่ม',
    counter: '{n}/100',
    close: 'ปิด',
    cancel: 'ยกเลิก',
    save: 'บันทึก',
    saving: 'กำลังบันทึก…',
    errForbidden: 'คุณไม่มีสิทธิ์เปลี่ยนชื่อกลุ่มนี้แล้ว',
    errNetwork: 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง',
    errGeneric: 'เปลี่ยนชื่อไม่สำเร็จ กรุณาลองอีกครั้ง',
  },
  en: {
    menu: 'Rename group',
    title: 'Rename group',
    subtitle: 'Everyone in this group sees the new name in the chat list and the room header.',
    label: 'Group name',
    counter: '{n}/100',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    errForbidden: 'You no longer have permission to rename this group.',
    errNetwork: 'Could not connect. Check your internet and try again.',
    errGeneric: 'Could not rename the group. Please try again.',
  },
};
export type RenameTextKey = keyof typeof renameText.th;

/** FR-WS-004 / DEC-093 — the same dialog renames the workspace; only the wording differs. */
export const workspaceRenameText: Record<'th' | 'en', Partial<Record<RenameTextKey, string>>> = {
  th: {
    menu: 'เปลี่ยนชื่อ workspace',
    title: 'เปลี่ยนชื่อ workspace',
    subtitle: 'ทุกคนใน workspace จะเห็นชื่อใหม่ที่แถบด้านข้างและหัวข้อหน้าต่าง',
    label: 'ชื่อ workspace',
    errForbidden: 'คุณไม่มีสิทธิ์เปลี่ยนชื่อ workspace นี้แล้ว',
    errGeneric: 'เปลี่ยนชื่อไม่สำเร็จ กรุณาลองอีกครั้ง',
  },
  en: {
    menu: 'Rename workspace',
    title: 'Rename workspace',
    subtitle: 'Everyone in the workspace sees the new name in the sidebar and the window title.',
    label: 'Workspace name',
    errForbidden: 'You no longer have permission to rename this workspace.',
    errGeneric: 'Could not rename the workspace. Please try again.',
  },
};
