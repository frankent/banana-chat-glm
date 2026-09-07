import { useState } from 'react';
import { endpoints } from '../../lib/api';
import { useRooms } from '../../hooks/useRooms';

/**
 * FR-AI-015 — share an assistant answer into a room (member rooms of the
 * current workspace only; the server enforces it too, TC-AI-103).
 */
export function AiShareDialog({
  messageId,
  slug,
  onClose,
  onShared,
}: {
  messageId: string;
  slug: string;
  onClose: () => void;
  onShared: (roomName: string) => void;
}) {
  const { data } = useRooms(slug);
  const rooms = data ?? [];
  const [roomId, setRoomId] = useState<string | null>(rooms[0]?.room.id ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const share = async (): Promise<void> => {
    if (roomId === null) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await endpoints.aiShare(messageId, slug, roomId);
      onShared(rooms.find((r) => r.room.id === roomId)?.room.name ?? 'ห้อง');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ส่งไม่สำเร็จ');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40" role="dialog" aria-label="ส่งคำตอบไปห้อง">
      <div className="w-96 rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-2 text-sm font-bold text-slate-700">📤 ส่งคำตอบนี้ไปห้อง</h2>
        <div className="max-h-64 overflow-y-auto">
          {rooms.length === 0 ? <p className="py-4 text-center text-xs text-slate-400">ไม่มีห้องที่เข้าร่วม</p> : null}
          {rooms.map((r) => (
            <label key={r.room.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              <input type="radio" name="share-room" checked={roomId === r.room.id} onChange={() => setRoomId(r.room.id)} />
              <span className="truncate">{r.room.name}</span>
              {r.room.type === 'dm' ? <span className="text-xs text-slate-400">DM</span> : null}
            </label>
          ))}
        </div>
        {error !== null ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            ยกเลิก
          </button>
          <button
            onClick={() => void share()}
            disabled={roomId === null || sending}
            className="rounded bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-40"
          >
            {sending ? 'กำลังส่ง…' : 'ส่ง'}
          </button>
        </div>
      </div>
    </div>
  );
}
