import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { useSession } from '../../state/session';
import { useAiStore } from '../../state/ai';
import { useChatText } from '../../lib/use-chat-text';
import { AiChatPane } from './AiChatPane';
import { AiConsentDialog } from './AiConsentDialog';
import { AiMemoriesPanel } from './AiMemoriesPanel';
import { AiNotConfigured } from './AiNotConfigured';
import { Icon } from '../Visual';

/**
 * FR-AI-001/002 — AI Assistant pane (/ai, /ai/:conversationId). The
 * conversation list itself now lives in AppShell's sidebar (AiConversationList,
 * DEC-078) so this component owns only the pane: header, chat, empty/memories
 * states. Conversations are user-owned and cross-workspace (DEC-015); the
 * workspace context only gates availability.
 */
export function AiAssistantView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { text } = useChatText();
  const { currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug ?? '';
  const { status, open, closeConversation, newConversation, consentOpen, giveConsent } = useAiStore();
  // `/ai/memories` (DEC-078) — a real route, not client-only state, so it
  // rides the same is-conversation mobile machinery as `/ai/:id`: on a
  // phone, toggling a flag left `.bc-main` display:none under `is-chat-list`
  // with nothing else to show it (the consent-dialog bug, recurring).
  const memoriesOpen = conversationId === 'memories';
  // FR-AI-001 AC#2. Positively confirmed, not `!== false`: while status is still
  // unknown we must not fire requests the gate is about to 503, and
  // `open()` -> loadMessages awaits without a catch while its caller discards the
  // promise, so a doomed call surfaces as an unhandled rejection rather than noise.
  const aiReady = status !== null && status.configured && status.allowed_in_workspace;
  const notConfigured = status !== null && !status.configured;

  useEffect(() => {
    if (aiReady && conversationId !== undefined && !memoriesOpen && slug !== '') {
      void open(conversationId, slug);
      // API-118 — release the push-suppression window when leaving/switching
      return () => {
        void endpoints.aiFocus(conversationId, slug, false).catch(() => undefined);
      };
    }
    closeConversation();
    return undefined;
  }, [aiReady, conversationId, memoriesOpen, slug, open, closeConversation]);

  const { data: memories } = useQuery({
    queryKey: ['ai', 'memories', slug],
    queryFn: () => endpoints.aiMemories(slug),
    enabled: aiReady && memoriesOpen && slug !== '',
  });

  if (status?.enabled === false) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">{text('ai.disabled')}</div>;
  }
  if (status !== null && !status.allowed_in_workspace) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">{text('ai.notAllowed')}</div>;
  }

  return (
    <div className="bc-conversation-pane flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="bc-chat-header">
        <button className="bc-chat-back bc-chat-control" aria-label={text('chat.back')} onClick={() => navigate('/ai')}>
          <Icon name="back" />
        </button>
        <div className="bc-chat-identity">
          <span className="bc-ai-avatar bc-avatar"><Icon name="sparkle" size={18} /></span>
          <div>
            <h2>{memoriesOpen ? text('ai.memories') : text('ai.title')}</h2>
          </div>
        </div>
      </header>
      {notConfigured ? (
        // Before the chat/memories branches and before the deep-link case: a
        // /ai/:id link must not mount a composer that cannot send. Rendered inside
        // the pane rather than instead of it so the header keeps its back button.
        <AiNotConfigured variant="pane" />
      ) : memoriesOpen ? (
        <AiMemoriesPanel memories={memories?.memories ?? []} slug={slug} />
      ) : conversationId !== undefined ? (
        <AiChatPane conversationId={conversationId} slug={slug} />
      ) : (
        <div className="bc-empty-conversation">
          <Icon name="sparkle" size={30} />
          <h3>{text('ai.selectPrompt')}</h3>
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
  );
}
