import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';

/**
 * FR-SRCH-002 — room info "media / files" tab, backed by /search/files?room_id
 * (API-081). q is a wildcard name filter; the room scope comes from room_id.
 */
export function RoomMediaPanel({ roomId, slug, onClose }: { roomId: string; slug: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'image' | 'video' | 'file' | ''>('');

  const query = useQuery({
    queryKey: ['room-media', roomId, q, kind],
    queryFn: () =>
      endpoints.searchFiles(slug, { q: q.trim() === '' ? '.' : q.trim(), room_id: roomId, ...(kind !== '' ? { kind } : {}) }),
    staleTime: 30_000,
  });

  const rows = query.data?.results ?? [];

  return (
    <aside
      role="complementary"
      aria-label="Room media and files"
      className="flex w-72 shrink-0 flex-col border-l border-slate-200 bg-white"
      data-testid="room-media-panel"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="text-sm font-semibold">Media & files</span>
        <button onClick={onClose} aria-label="Close media panel" className="text-xs text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </div>
      <div className="space-y-2 border-b border-slate-100 p-2">
        <label htmlFor="media-q" className="sr-only">
          Filter by name
        </label>
        <input
          id="media-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-yellow-400 focus:outline-none"
        />
        <div role="tablist" aria-label="Kind" className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
          {(
            [
              ['', 'All'],
              ['image', 'Images'],
              ['video', 'Videos'],
              ['file', 'Files'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              role="tab"
              aria-selected={kind === value}
              onClick={() => setKind(value)}
              className={`flex-1 rounded-md px-2 py-1 font-medium ${kind === value ? 'bg-white shadow-sm' : 'text-slate-500'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {!query.isLoading && rows.length === 0 && <p className="text-sm text-slate-400">No shared files yet.</p>}
        <ul className="space-y-1">
          {rows.map((row) => (
            <li key={`${row.attachment.id}-${row.message.id}`}>
              <a
                href={`/rooms/${row.message.room_id}?around_seq=${row.message.seq}`}
                className="block rounded-lg px-2 py-1.5 hover:bg-yellow-50"
                data-testid="room-media-item"
              >
                <span className="block truncate text-sm font-medium text-slate-700">
                  {row.attachment.kind === 'image' ? '🖼' : row.attachment.kind === 'video' ? '🎬' : '📄'}{' '}
                  {row.attachment.original_name}
                </span>
                <span className="block text-xs text-slate-400">
                  {(row.attachment.size_bytes / 1024).toFixed(0)} KB · {new Date(row.attachment.created_at).toLocaleDateString()}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
