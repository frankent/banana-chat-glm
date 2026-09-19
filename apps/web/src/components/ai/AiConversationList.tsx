import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../lib/api';
import { useAiStore } from '../../state/ai';
import { useChatText } from '../../lib/use-chat-text';
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
  const isSearching = debounced.length >= 2;

  const startNewChat = () => {
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
      </div>
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
      <nav className="bc-room-list" aria-label={text('ai.title')}>
        {isSearching ? (
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
            {loading && conversations.length === 0 && (
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
            {!loading && conversations.length === 0 && (
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
