import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { useSession } from '../../state/session';
import { useAiStore } from '../../state/ai';
import { AiChatPane } from './AiChatPane';
import { AiMemoriesPanel } from './AiMemoriesPanel';

/**
 * FR-AI-001/002 — AI Assistant page (/ai). Conversations are user-owned and
 * cross-workspace (DEC-015); the workspace context only gates availability.
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
  } = useAiStore();
  const [showMemories, setShowMemories] = useState(false);

  useEffect(() => {
    if (slug !== '') {
      void refreshStatus(slug);
      void loadConversations(slug);
    }
  }, [slug, refreshStatus, loadConversations]);

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
    <div className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="space-y-2 border-b border-slate-100 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-slate-700">✨ AI Assistant</span>
            <button
              onClick={() => void newConversation(slug)}
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
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
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
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {showMemories ? (
          <AiMemoriesPanel memories={memories?.memories ?? []} slug={slug} />
        ) : conversationId !== undefined ? (
          <AiChatPane conversationId={conversationId} slug={slug} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            เลือกบทสนทนา หรือเริ่มแชทใหม่
          </div>
        )}
      </div>
    </div>
  );
}
