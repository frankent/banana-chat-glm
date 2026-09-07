/**
 * FR-AI-007 — explicit consent modal. The composer stays blocked until the
 * user accepts (AI_CONSENT_REQUIRED otherwise).
 */
export function AiConsentDialog({ onAccept }: { onAccept: () => Promise<void> | void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="mb-2 text-base font-bold text-slate-800">ใช้ AI Assistant ต้องให้ความยินยอม</h2>
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>ข้อความของคุณจะถูกส่งไปยังผู้ให้บริการ AI เพื่อสร้างคำตอบ</li>
          <li>AI จะจำข้อมูลเกี่ยวกับคุณเพื่อตอบให้ดีขึ้นข้าม workspace (ดู/ลบได้ใน "ความจำของฉัน")</li>
          <li>ห้ามส่งข้อมูลลับขององค์กรที่ไม่ได้รับอนุญาต</li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => void onAccept()}
            className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-300"
          >
            ยินยอมและเริ่มใช้
          </button>
        </div>
      </div>
    </div>
  );
}
