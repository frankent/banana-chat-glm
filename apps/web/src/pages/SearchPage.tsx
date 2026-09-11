import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { FileSearchResult, MessageSearchResult } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useRooms } from '../hooks/useRooms';
import { useSession } from '../state/session';

/**
 * TASK-WEB-017 — global search (FR-SRCH-001/002): messages + files, filters,
 * jump-to-result via ?around_seq=. Opened with Ctrl/Cmd+K (TASK-WEB-018).
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug;

  const initialQ = params.get('q') ?? '';
  const [q, setQ] = useState(initialQ);
  const [tab, setTab] = useState<'messages' | 'files'>('messages');
  const [roomId, setRoomId] = useState<string>('');
  const [kind, setKind] = useState<'image' | 'video' | 'file' | ''>('');
  const [cursor, setCursor] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // deep link ?q= (Ctrl+K passes it through)
  useEffect(() => {
    const deep = params.get('q');
    if (deep !== null && deep !== initialQ) {
      setQ(deep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const { data: rooms } = useRooms(slug);
  const trimmed = q.trim();
  const searchable = slug !== undefined && trimmed.length >= 2;

  const messagesQuery = useQuery({
    queryKey: ['search', 'messages', slug, trimmed, roomId, tab],
    queryFn: () =>
      endpoints.searchMessages(slug!, {
        q: trimmed,
        ...(roomId !== '' ? { room_id: roomId } : {}),
      }),
    enabled: searchable && tab === 'messages',
    staleTime: 30_000,
  });

  const filesQuery = useQuery({
    queryKey: ['search', 'files', slug, trimmed, roomId, kind, tab],
    queryFn: () =>
      endpoints.searchFiles(slug!, {
        q: trimmed,
        ...(roomId !== '' ? { room_id: roomId } : {}),
        ...(kind !== '' ? { kind } : {}),
      }),
    enabled: searchable && tab === 'files',
    staleTime: 30_000,
  });

  const results = useMemo(() => {
    if (tab === 'messages') {
      return { rows: messagesQuery.data?.results ?? [], next: messagesQuery.data?.next_cursor ?? null };
    }
    return { rows: filesQuery.data?.results ?? [], next: filesQuery.data?.next_cursor ?? null };
  }, [tab, messagesQuery.data, filesQuery.data]);

  // cursor page appended locally (keep-first pagination)
  const [older, setOlder] = useState<{ messages: MessageSearchResult[]; files: FileSearchResult[] }>({ messages: [], files: [] });
  useEffect(() => {
    setOlder({ messages: [], files: [] });
    setCursor(null);
  }, [trimmed, roomId, kind, tab]);

  const loadMore = async () => {
    if (slug === undefined || cursor === null) {
      return;
    }
    if (tab === 'messages') {
      const page = await endpoints.searchMessages(slug, { q: trimmed, cursor, ...(roomId !== '' ? { room_id: roomId } : {}) });
      setOlder((prev) => ({ ...prev, messages: [...prev.messages, ...page.results] }));
      setCursor(page.next_cursor);
    } else {
      const page = await endpoints.searchFiles(slug, {
        q: trimmed,
        cursor,
        ...(roomId !== '' ? { room_id: roomId } : {}),
        ...(kind !== '' ? { kind } : {}),
      });
      setOlder((prev) => ({ ...prev, files: [...prev.files, ...page.results] }));
      setCursor(page.next_cursor);
    }
  };

  // seed the cursor from the first page
  useEffect(() => {
    if (results.next !== null && cursor === null) {
      setCursor(results.next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.next]);

  const jump = (roomId_: string, seq: number) => {
    navigate(`/rooms/${roomId_}?around_seq=${seq}`);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams(params);
    if (trimmed !== '') next.set('q', trimmed);
    else next.delete('q');
    setParams(next, { replace: true });
  };

  const loading = tab === 'messages' ? messagesQuery.isFetching : filesQuery.isFetching;
  const messageRows = [...(tab === 'messages' ? older.messages : []), ...(tab === 'messages' ? (results.rows as MessageSearchResult[]) : [])];
  const fileRows = [...(tab === 'files' ? older.files : []), ...(tab === 'files' ? (results.rows as FileSearchResult[]) : [])];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor="search-q" className="sr-only">
            Search messages and files
          </label>
          <input
            id="search-q"
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหาข้อความหรือไฟล์… (minimum 2 characters)"
            className="min-w-0 w-full max-w-xl rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-yellow-400 focus:outline-none"
            data-testid="search-input"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-yellow-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-yellow-300"
          >
            Search
          </button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <div role="tablist" aria-label="Search mode" className="flex rounded-lg bg-slate-100 p-0.5">
            {(['messages', 'files'] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md px-3 py-1 font-medium capitalize ${tab === value ? 'bg-white shadow-sm' : 'text-slate-500'}`}
              >
                {value}
              </button>
            ))}
          </div>
          <label htmlFor="search-room" className="sr-only">
            Filter by room
          </label>
          <select
            id="search-room"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            className="min-w-0 max-w-full rounded-lg border border-slate-300 px-2 py-1"
            data-testid="search-room-filter"
          >
            <option value="">All rooms</option>
            {rooms?.map((entry) => (
              <option key={entry.room.id} value={entry.room.id}>
                {entry.room.type === 'dm' ? '· ' : '# '}
                {entry.room.type === 'dm' ? entry.other_user?.display_name ?? 'Direct message' : entry.room.name}
              </option>
            ))}
          </select>
          {tab === 'files' && (
            <>
              <label htmlFor="search-kind" className="sr-only">
                Filter by kind
              </label>
              <select
                id="search-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                className="min-w-0 max-w-full rounded-lg border border-slate-300 px-2 py-1"
              >
                <option value="">All kinds</option>
                <option value="image">Images</option>
                <option value="video">Videos</option>
                <option value="file">Files</option>
              </select>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="search-results">
        {!searchable && <p className="text-sm text-slate-400">Type at least 2 characters to search.</p>}
        {searchable && loading && messageRows.length + fileRows.length === 0 && (
          <p className="text-sm text-slate-400">Searching…</p>
        )}

        {tab === 'messages' &&
          searchable &&
          !loading &&
          messageRows.length === 0 && <p className="text-sm text-slate-400">No messages found.</p>}
        <ul className="space-y-1">
          {tab === 'messages' &&
            messageRows.map((row) => (
              <li key={row.message.id}>
                <button
                  onClick={() => jump(row.message.room_id, row.message.seq)}
                  className="w-full rounded-lg bg-white px-3 py-2 text-left shadow-sm hover:bg-yellow-50"
                  data-testid="search-result-message"
                >
                  <span className="mb-0.5 flex items-center gap-2 text-xs text-slate-400">
                    <span className="font-semibold text-slate-600">
                      {row.room?.type === 'dm' ? '·' : '#'} {row.room?.name ?? 'Direct message'}
                    </span>
                    <span>{row.message.sender?.display_name}</span>
                    <span>{new Date(row.message.created_at).toLocaleString()}</span>
                  </span>
                  {/* server pre-escapes; only <mark> is raw HTML (TC-SRCH-005) */}
                  <span className="block text-sm text-slate-800" dangerouslySetInnerHTML={{ __html: row.highlight }} />
                </button>
              </li>
            ))}
        </ul>

        {tab === 'files' &&
          searchable &&
          !loading &&
          fileRows.length === 0 && <p className="text-sm text-slate-400">No files found.</p>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {tab === 'files' &&
            fileRows.map((row) => (
              <button
                key={`${row.attachment.id}-${row.message.id}`}
                onClick={() => jump(row.message.room_id, row.message.seq)}
                className="rounded-lg bg-white p-2 text-left shadow-sm hover:bg-yellow-50"
                data-testid="search-result-file"
              >
                <span className="block truncate text-sm font-medium text-slate-700">
                  {row.attachment.kind === 'image' ? '🖼' : row.attachment.kind === 'video' ? '🎬' : '📄'}{' '}
                  {row.attachment.original_name}
                </span>
                <span className="block truncate text-xs text-slate-400">
                  {row.room?.name ?? 'Direct message'} · {(row.attachment.size_bytes / 1024).toFixed(0)} KB ·{' '}
                  {new Date(row.attachment.created_at).toLocaleDateString()}
                </span>
              </button>
            ))}
        </div>

        {cursor !== null && (
          <button
            onClick={() => void loadMore()}
            className="mx-auto mt-3 block rounded-full bg-white px-4 py-1 text-xs font-medium text-slate-500 shadow-sm hover:bg-slate-50"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
