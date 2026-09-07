import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AiMemory, AiMemoryCategory } from '@banana-chat/shared';
import { endpoints } from '../../lib/api';

/**
 * FR-AI-007 (TC-AI-067..072) — memory management: list, manual add, delete,
 * clear-all. Memories are cross-workspace (DEC-016) and user-owned.
 */
const CATEGORIES: AiMemoryCategory[] = ['profile', 'preference', 'project', 'other'];

export function AiMemoriesPanel({ memories, slug }: { memories: AiMemory[]; slug: string }) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<AiMemoryCategory>('preference');
  const [busy, setBusy] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['ai', 'memories', slug] });

  const add = async (): Promise<void> => {
    if (content.trim().length < 2 || busy) {
      return;
    }
    setBusy(true);
    try {
      await endpoints.aiAddMemory(slug, content.trim(), category);
      setContent('');
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-100 p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h2 className="text-base font-bold text-slate-800">🧠 ความจำของฉัน</h2>
          <p className="text-xs text-slate-500">
            ข้อมูลที่ AI จำเกี่ยวกับคุณ (ใช้ร่วมทุก workspace) — เพิ่ม/ลบได้ทุกเมื่อ
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex gap-2">
            <input
              value={content}
              onChange={(e) => setContent(e.target.value.slice(0, 300))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="เช่น ชอบคำตอบสั้น กระชับ"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as AiMemoryCategory)}
              className="rounded-lg border border-slate-200 px-2 py-2 text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              onClick={() => void add()}
              disabled={busy || content.trim().length < 2}
              className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-40"
            >
              เพิ่ม
            </button>
          </div>
        </div>

        {memories.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">ยังไม่มีความจำ — คุยกับ AI ไปเรื่อย ๆ หรือเพิ่มเองด้านบน</p>
        ) : (
          <ul className="space-y-2">
            {memories.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-800">{m.content}</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    {m.category} · สำคัญ {m.importance}/5 · จาก{m.source === 'user' ? 'คุณ' : 'AI'}
                  </p>
                </div>
                <button
                  onClick={() => {
                    void endpoints.aiDeleteMemory(m.id, slug).then(refresh);
                  }}
                  className="shrink-0 rounded border border-slate-200 px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                >
                  ลบ
                </button>
              </li>
            ))}
          </ul>
        )}

        {memories.length > 0 ? (
          <button
            onClick={() => {
              void endpoints.aiClearMemories(slug).then(refresh);
            }}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
          >
            ล้างความจำทั้งหมด
          </button>
        ) : null}
      </div>
    </div>
  );
}
