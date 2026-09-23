import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { useAiStore } from '../../state/ai';
import { useChatText } from '../../lib/use-chat-text';
import { AiNotConfigured } from './AiNotConfigured';
import { Icon } from '../Visual';

/**
 * DEC-078 — the AI conversation list, styled like RoomList (bc-conversations/
 * bc-room-row) so `/ai*` shares the chat shell's sidebar instead of a second,
 * differently-styled list living inside the pane. FR-AI-020 (WEB-024) search
 * is unchanged: debounced, ≥2 chars, server-side (API-116).
 */
export function AiConversationList({ slug }: { slug: string }) {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { text } = useChatText();
  const { status, refreshStatus, loadConversations, newConversation, conversations, loading, setConsentOpen } = useAiStore();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [search]);

  // FR-AI-001 AC#2 — no provider is is_enabled && is_default. Status still has to
  // load (it is what tells us), but nothing that needs the gate should run.
  const notConfigured = status !== null && !status.configured;
  const aiReady = status !== null && status.configured && status.allowed_in_workspace;

  useEffect(() => {
    if (slug !== '') {
      void refreshStatus(slug);
    }
  }, [slug, refreshStatus]);

  // `loading` alone is not enough: aiReady flips during render, and loadConversations
  // cannot set loading:true until the effect runs after commit, leaving one frame in
  // which ai.empty would render. Only a completed load proves the list is really empty.
  const [everLoaded, setEverLoaded] = useState(false);
  useEffect(() => {
    if (aiReady && slug !== '') {
      void loadConversations(slug).finally(() => setEverLoaded(true));
    }
  }, [aiReady, slug, loadConversations]);

  const { data: searchPage, isFetching: searching } = useQuery({
    queryKey: ['ai', 'search', slug, debounced],
    queryFn: () => endpoints.aiSearch(slug, debounced),
    enabled: aiReady && slug !== '' && debounced.length >= 2,
  });
  const searchResults = useMemo(() => searchPage?.results ?? [], [searchPage]);
  const isSearching = debounced.length >= 2;

  const startNewChat = () => {
    // Status still loading is "unknown", not "fine": without this, a cold load on an
    // unconfigured instance renders the button (notConfigured is false while status
    // is null), and the 503 lands in the catch below as a consent dialog.
    if (!aiReady) return;
    void newConversation(slug)
      .then((id) => {
        if (id !== null) void navigate(`/ai/${id}`);
      })
      .catch(() => setConsentOpen(true));
  };

  return (
    <div className="bc-conversations">
      <div className="bc-conversations-title">
        <h1>{text('ai.title')}</h1>
        {/* Not rendered rather than `hidden`: these 503/403 whenever the gate is not
            satisfied, and `aiReady` covers all three of unknown, unconfigured and
            workspace-denied (which reports configured:true, so notConfigured missed
            it). It also drops a dependency on Tailwind preflight's
            [hidden]{display:none!important} to beat these elements' own display:flex. */}
        {aiReady && (
        <div className="flex gap-1">
          <NavLink
            to="/ai/memories"
            className={({ isActive }) => `bc-chat-control ${isActive ? 'active' : ''}`}
            aria-label={`${text('ai.memories')}${status?.memory_enabled === true ? '' : text('ai.memoriesOff')}`}
          >
            <Icon name="notes" size={19} />
          </NavLink>
          <button className="bc-chat-control bc-new-chat" aria-label={text('ai.newChat')} onClick={startNewChat}>
            <Icon name="edit" size={19} />
          </button>
        </div>
        )}
      </div>
      {aiReady && (
      <label className="bc-chat-search">
        <Icon name="search" size={18} />
        <input
          aria-label={text('ai.search')}
          placeholder={text('ai.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search !== '' && (
          <button className="bc-chat-control" aria-label={text('chat.cancel')} onClick={() => setSearch('')}>
            <Icon name="close" size={16} />
          </button>
        )}
      </label>
      )}
      <nav className="bc-room-list" aria-label={text('ai.title')}>
        {notConfigured ? (
          // Ahead of every other branch, including cached conversations: rows can
          // survive in the offline cache after a provider is removed, and showing
          // them would offer links that 503 on open.
          <AiNotConfigured variant="list" />
        ) : status !== null && !status.allowed_in_workspace ? (
          // Unreachable until the status fix above, which is what made denial
          // distinguishable at all. Without this it fell through to ai.empty and
          // invited a new chat with no button rendered to start one.
          <div className="bc-chat-list-empty">
            <Icon name="sparkle" size={28} />
            <strong>{text('ai.notAllowed')}</strong>
          </div>
        ) : aiReady && isSearching ? (
          <>
            <p className="bc-list-error" role="status">
              {searching ? text('ai.searching') : text('ai.searchResults').replace('{count}', String(searchResults.length))}
            </p>
            {searchResults.map((result) => (
              <NavLink
                key={result.message.id}
                to={`/ai/${result.conversation?.id ?? result.message.conversation_id}`}
                className={({ isActive }) => `bc-room-row ${isActive ? 'selected' : ''}`}
                onClick={() => setSearch('')}
              >
                <span className="bc-room-main">
                  <span className="bc-room-line1">
                    <span className="bc-room-name">{result.conversation?.title ?? text('ai.untitled')}</span>
                  </span>
                  <span className="bc-room-line2">
                    <span className="bc-room-preview">{result.message.content ?? ''}</span>
                  </span>
                </span>
              </NavLink>
            ))}
            {!searching && searchResults.length === 0 && (
              <div className="bc-chat-list-empty">
                <strong>{text('ai.noResults')}</strong>
              </div>
            )}
          </>
        ) : (
          <>
            {(status === null || loading || !everLoaded) && conversations.length === 0 && (
              <div aria-label={text('chat.loading')}>
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="bc-room-row bc-room-skeleton">
                    <span className="bc-skel-circle" />
                    <span className="bc-room-main">
                      <span className="bc-skel-line" />
                      <span className="bc-skel-line" />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {conversations.map((conversation) => (
              <NavLink
                key={conversation.id}
                to={`/ai/${conversation.id}`}
                className={({ isActive }) => `bc-room-row ${isActive ? 'selected' : ''}`}
              >
                <span className="bc-room-avatar" aria-hidden="true">
                  <span className="bc-ai-avatar"><Icon name="sparkle" size={18} /></span>
                </span>
                <span className="bc-room-main">
                  <span className="bc-room-line1">
                    <span className={`bc-room-name ${conversation.id === conversationId ? 'unread' : ''}`}>
                      {conversation.title ?? text('ai.untitled')}
                    </span>
                    {conversation.generating && <span className="bc-room-unread" aria-hidden="true">•</span>}
                  </span>
                </span>
              </NavLink>
            ))}
            {/* `aiReady &&` matters: gating loadConversations on status means `loading`
                is still false while status is in flight, so this branch would other-
                wise render "no conversations yet / start a new chat" on every healthy
                cold load -- to a returning user with a full cached list, no less. */}
            {aiReady && everLoaded && !loading && conversations.length === 0 && (
              <div className="bc-chat-list-empty">
                <Icon name="sparkle" size={28} />
                <strong>{text('ai.empty')}</strong>
                <p>{text('ai.emptyHint')}</p>
              </div>
            )}
          </>
        )}
      </nav>
    </div>
  );
}
