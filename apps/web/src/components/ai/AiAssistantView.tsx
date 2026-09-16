import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { useSession } from '../../state/session';
import { useAiStore } from '../../state/ai';
import { AiChatPane } from './AiChatPane';
import { AiConsentDialog } from './AiConsentDialog';
import { AiMemoriesPanel } from './AiMemoriesPanel';

/**
 * FR-AI-001/002 — AI Assistant page (/ai). Conversations are user-owned and
 * cross-workspace (DEC-015); the workspace context only gates availability.
 * FR-AI-020 (WEB-024) — sidebar search over own conversations (API-116).
 */
export function AiAssistantView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug ?? '';
  const {
    status,
    refreshStatus,
    loadConversations,
    open,
    closeConversation,
    newConversation,
    conversations,
    loading,
    consentOpen,
    setConsentOpen,
    giveConsent,
  } = useAiStore();
  const [showMemories, setShowMemories] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  // debounce the AI search box (API-116, q ≥ 2 chars)
  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [search]);

  useEffect(() => {
    if (slug !== '') {
      void refreshStatus(slug);
      void loadConversations(slug);
    }
  }, [slug, refreshStatus, loadConversations]);

  const { data: searchPage, isFetching: searching } = useQuery({
    queryKey: ['ai', 'search', slug, debounced],
    queryFn: () => endpoints.aiSearch(slug, debounced),
    enabled: slug !== '' && debounced.length >= 2,
  });
  const searchResults = useMemo(() => searchPage?.results ?? [], [searchPage]);

  useEffect(() => {
    if (conversationId !== undefined && slug !== '') {
      void open(conversationId, slug);
      // API-118 — release the push-suppression window when leaving/switching
      return () => {
        void endpoints.aiFocus(conversationId, slug, false).catch(() => undefined);
      };
    }
    closeConversation();
    return undefined;
  }, [conversationId, slug, open, closeConversation]);

  const { data: memories } = useQuery({
    queryKey: ['ai', 'memories', slug],
    queryFn: () => endpoints.aiMemories(slug),
    enabled: showMemories && slug !== '',
  });

  if (status?.enabled === false) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        AI Assistant ปิดใช้งานในระบบนี้
      </div>
    );
  }
  if (status !== null && !status.allowed_in_workspace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        AI Assistant ไม่พร้อมใช้งานใน workspace นี้
      </div>
    );
  }

  return (
    <div className="bc-ai-view flex h-full min-h-0">
      <div className="bc-ai-sidebar flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="space-y-2 border-b border-slate-100 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-slate-700">✨ AI Assistant</span>
            <button
              // FR-AI-007 — first conversation on a fresh account 403s with
              // AI_CONSENT_REQUIRED; surface the consent modal instead of
              // silently doing nothing (no chat pane exists to show it).
              onClick={() =>
                void newConversation(slug)
                  .then((id) => {
                    if (id !== null) void navigate(`/ai/${id}`);
                  })
                  .catch(() => setConsentOpen(true))
              }
              className="rounded bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-900 hover:bg-amber-300"
            >
              + แชทใหม่
            </button>
          </div>
          <button
            onClick={() => setShowMemories((v) => !v)}
            className="w-full rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            🧠 ความจำของฉัน {status?.memory_enabled === true ? '' : '(ปิดอยู่)'}
          </button>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 ค้นหาในบทสนทนา AI…"
            aria-label="ค้นหาบทสนทนา AI"
            className="w-full rounded border border-slate-200 px-2 py-1 text-xs focus:border-amber-400 focus:outline-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {debounced.length >= 2 ? (
            <>
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase text-slate-400">
                ผลการค้นหา {searching ? '…' : `(${searchResults.length})`}
              </p>
              {searchResults.map((r) => (
                <button
                  key={r.message.id}
                  onClick={() => {
                    setSearch('');
                    setShowMemories(false);
                    navigate(`/ai/${r.conversation?.id ?? r.message.conversation_id}`);
                  }}
                  className="block w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-slate-50"
                >
                  <span className="block truncate text-xs font-semibold text-slate-700">
                    {r.conversation?.title ?? 'แชทไม่มีชื่อ'}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-slate-400">{r.message.content ?? ''}</span>
                </button>
              ))}
              {!searching && searchResults.length === 0 ? (
                <p className="p-3 text-xs text-slate-400">ไม่พบผลลัพธ์</p>
              ) : null}
            </>
          ) : (
            <>
          {loading && conversations.length === 0 ? <p className="p-3 text-xs text-slate-400">กำลังโหลด…</p> : null}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setShowMemories(false);
                navigate(`/ai/${c.id}`);
              }}
              className={`block w-full truncate px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                c.id === conversationId ? 'bg-amber-50 font-semibold' : 'text-slate-700'
              }`}
            >
              {c.title ?? 'แชทใหม่'}
              {c.generating ? <span className="ml-1 animate-pulse text-amber-500">•</span> : null}
            </button>
          ))}
          {!loading && conversations.length === 0 ? (
            <p className="p-3 text-xs text-slate-400">ยังไม่มีบทสนทนา — กด "แชทใหม่" เริ่มคุยกับ AI</p>
          ) : null}
            </>
          )}
        </div>
      </div>
      <div className="bc-ai-content min-w-0 flex-1">
        {showMemories ? (
          <AiMemoriesPanel memories={memories?.memories ?? []} slug={slug} />
        ) : conversationId !== undefined ? (
          <AiChatPane conversationId={conversationId} slug={slug} />
        ) : (
          <div className="relative flex h-full items-center justify-center text-sm text-slate-400">
            เลือกบทสนทนา หรือเริ่มแชทใหม่
            {consentOpen ? (
              <AiConsentDialog
                onAccept={() =>
                  giveConsent(slug)
                    .then(() => newConversation(slug))
                    .then((id) => {
                      if (id !== null) void navigate(`/ai/${id}`);
                    })
                    .catch(() => undefined)
                }
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
