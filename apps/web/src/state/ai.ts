import { create } from 'zustand';
import type { AiConversationSummary, AiMessage, AiStatus, AiStreamEvent } from '@banana-chat/shared';
import { createAiStreamStore, type AiCacheAdapter } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';
import { aiCache } from '../lib/cache';
import { useSession } from './session';

/**
 * FR-AI-018 — client AI state. The per-message delta machine lives in
 * chat-core (AiStreamStore); this store owns conversation/message caches,
 * resync-on-gap (API-117), and focus pings (API-118).
 */

const streamStore = createAiStreamStore();

/** TASK-CORE-010 wiring — AI cache follows the logged-in user, not the ws. */
function cacheFor(): AiCacheAdapter | null {
  const me = useSession.getState().me;
  return me === null ? null : aiCache(me.id);
}

function uuid(): string {
  return crypto.randomUUID();
}

interface AiState {
  status: AiStatus | null;
  statusError: string | null;
  conversations: AiConversationSummary[];
  activeId: string | null;
  /** appended message list per conversation, oldest → newest */
  messages: Record<string, AiMessage[]>;
  hasMoreBefore: Record<string, boolean>;
  /** FR-AI-009 — superseded versions fetched for the "1/2" toggle */
  supersededVisible: Record<string, boolean>;
  loading: boolean;
  sending: boolean;
  /** bump on every stream mutation so subscribers re-render */
  streamTick: number;
  consentOpen: boolean;

  refreshStatus: (slug: string) => Promise<void>;
  loadConversations: (slug: string) => Promise<void>;
  open: (conversationId: string, slug: string) => Promise<void>;
  loadOlder: (conversationId: string, slug: string) => Promise<void>;
  newConversation: (slug: string) => Promise<string | null>;
  send: (conversationId: string, slug: string, content: string) => Promise<void>;
  cancel: (messageId: string, slug: string) => Promise<void>;
  retry: (conversationId: string, slug: string, content: string) => Promise<void>;
  /** API-114 — regenerate the latest assistant answer (FR-AI-009) */
  regenerate: (conversationId: string, messageId: string, slug: string) => Promise<void>;
  /** API-115 — edit the latest user message and re-send (FR-AI-009) */
  editResend: (conversationId: string, messageId: string, slug: string, content: string) => Promise<void>;
  /** FR-AI-009 "1/2" — refetch with/without superseded rows */
  toggleSuperseded: (conversationId: string, slug: string) => Promise<void>;
  closeConversation: () => void;
  setConsentOpen: (open: boolean) => void;
  giveConsent: (slug: string) => Promise<void>;
  applyEvent: (event: AiStreamEvent) => Promise<void>;
  activeStreamText: (messageId: string) => string | null;
}

/** fire-and-forget resync when a stream flags a gap (API-117) */
async function resyncIfNeeded(messageId: string, get: () => AiState): Promise<void> {
  const s = streamStore.get(messageId);
  if (s === undefined || !s.needsResync) {
    return;
  }
  try {
    const res = await endpoints.aiShowMessage(messageId);
    streamStore.resync(messageId, res.partial_content, res.last_index, res.message);
    useAiStore.setState((st) => ({ streamTick: st.streamTick + 1 }));
    // the authoritative message may also finalize the list entry
    if (res.message.status !== 'pending' && res.message.status !== 'streaming') {
      upsertMessage(get, res.message);
    }
  } catch {
    // network hiccup — the next gap/event retries
  }
}

function upsertMessage(get: () => AiState, message: AiMessage): void {
  const list = get().messages[message.conversation_id];
  if (list === undefined) {
    return;
  }
  const at = list.findIndex((m) => m.id === message.id);
  const next = at >= 0 ? list.map((m) => (m.id === message.id ? message : m)) : [...list, message];
  useAiStore.setState((st) => ({
    messages: { ...st.messages, [message.conversation_id]: next },
    streamTick: st.streamTick + 1,
  }));
}

export const useAiStore = create<AiState>((set, get) => ({
  status: null,
  statusError: null,
  conversations: [],
  activeId: null,
  messages: {},
  hasMoreBefore: {},
  supersededVisible: {},
  loading: false,
  sending: false,
  streamTick: 0,
  consentOpen: false,

  async refreshStatus(slug) {
    try {
      const status = await endpoints.aiStatus(slug);
      set({ status, statusError: null });
    } catch (e) {
      set({ statusError: e instanceof Error ? e.message : 'AI unavailable', status: null });
    }
  },

  async loadConversations(slug) {
    set({ loading: true });
    // hydrate from cache for an instant list (CORE-010), then refresh
    const cache = cacheFor();
    if (cache !== null && get().conversations.length === 0) {
      const cached = await cache.loadConversations();
      if (cached !== null && get().conversations.length === 0) {
        set({ conversations: cached });
      }
    }
    try {
      const res = await endpoints.aiConversations(slug);
      set({ conversations: res.conversations, loading: false });
      void cache?.saveConversations(res.conversations);
    } catch {
      set({ loading: false });
    }
  },

  async open(conversationId, slug) {
    set({ activeId: conversationId });
    if (get().messages[conversationId] === undefined) {
      const cache = cacheFor();
      const cached = await cache?.loadMessages(conversationId);
      if (cached !== null && cached !== undefined && get().messages[conversationId] === undefined) {
        set((st) => ({ messages: { ...st.messages, [conversationId]: cached } }));
      }
      const page = await endpoints.aiMessages(conversationId, slug, { limit: 50 });
      const ascending = [...page.messages].reverse(); // API-106 returns newest-first
      set((st) => ({
        messages: { ...st.messages, [conversationId]: ascending },
        hasMoreBefore: { ...st.hasMoreBefore, [conversationId]: page.has_more_before },
      }));
      void cache?.saveMessages(conversationId, ascending);
    }
    // focus ping → suppress ai_completed push while the tab is open (API-118)
    void endpoints.aiFocus(conversationId, slug, true).catch(() => undefined);
  },

  async loadOlder(conversationId, slug) {
    const list = get().messages[conversationId] ?? [];
    const oldest = list[0];
    if (oldest === undefined) {
      return;
    }
    const page = await endpoints.aiMessages(conversationId, slug, { before_seq: oldest.seq, limit: 50 });
    set((st) => ({
      messages: { ...st.messages, [conversationId]: [...[...page.messages].reverse(), ...(st.messages[conversationId] ?? [])] },
      hasMoreBefore: { ...st.hasMoreBefore, [conversationId]: page.has_more_before },
    }));
  },

  async newConversation(slug) {
    const res = await endpoints.aiCreateConversation(slug);
    const conversation = res.conversation;
    set((st) => ({
      conversations: [conversation, ...st.conversations],
      messages: { ...st.messages, [conversation.id]: [] },
      hasMoreBefore: { ...st.hasMoreBefore, [conversation.id]: false },
      activeId: conversation.id,
    }));
    return conversation.id;
  },

  async send(conversationId, slug, content) {
    const st = get();
    if (st.status !== null && !st.status.consented) {
      set({ consentOpen: true });
      return;
    }
    set({ sending: true });
    // TC-CORE-046 — optimistic user bubble + typing-dots placeholder
    const clientMessageId = uuid();
    set((st) => ({
      messages: {
        ...st.messages,
        [conversationId]: [
          ...(st.messages[conversationId] ?? []),
          {
            id: 'optimistic-user',
            conversation_id: conversationId,
            seq: -1,
            role: 'user',
            status: 'completed',
            content,
            client_message_id: clientMessageId,
            parent_message_id: null,
            model: null,
            finish_reason: null,
            tokens_prompt: null,
            tokens_completion: null,
            error_code: null,
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
          } satisfies AiMessage,
        ],
      },
    }));
    try {
      const res = await endpoints.aiSend(conversationId, slug, content, clientMessageId);
      const list = get().messages[conversationId] ?? [];
      const merged = [
        ...list.filter((m) => m.id !== 'optimistic-user' && m.client_message_id !== res.user_message.client_message_id),
        res.user_message,
        ...(res.assistant_message !== null ? [res.assistant_message] : []),
      ];
      set((s2) => ({ messages: { ...s2.messages, [conversationId]: merged } }));
      void cacheFor()?.saveMessages(conversationId, merged);
      if (res.assistant_message !== null) {
        streamStore.seed(res.assistant_message);
      }
      // title may appear after the first exchange (FR-AI-008)
      void get().loadConversations(slug);
    } finally {
      set({ sending: false });
    }
  },

  async cancel(messageId, slug) {
    try {
      const res = await endpoints.aiCancel(messageId, slug);
      upsertMessage(get, res.message);
    } catch {
      // 409 race: job finished first — the completion event wins
    }
  },

  async retry(conversationId, slug, content) {
    const list = get().messages[conversationId] ?? [];
    const failed = [...list].reverse().find((m) => m.status === 'failed');
    if (failed !== undefined && failed.parent_message_id !== null) {
      // dropping the failed bubble + its user message; a fresh send follows
      set((st) => ({
        messages: {
          ...st.messages,
          [conversationId]: (st.messages[conversationId] ?? []).filter((m) => m.id !== failed.id && m.id !== failed.parent_message_id),
        },
      }));
    }
    await get().send(conversationId, slug, content);
  },

  /** API-114 — old answer → superseded (kept for the "1/2" toggle), new row streams. */
  async regenerate(conversationId, messageId, slug) {
    const res = await endpoints.aiRegenerate(messageId, slug);
    set((st) => {
      const list = st.messages[conversationId] ?? [];
      const next = list.map((m) => (m.id === messageId ? { ...m, superseded_at: m.superseded_at ?? new Date().toISOString() } : m));
      next.push(res.assistant_message);
      return { messages: { ...st.messages, [conversationId]: next }, streamTick: st.streamTick + 1 };
    });
    streamStore.seed(res.assistant_message);
    void get().refreshStatus(slug); // quota counter moved (FR-AI-010)
  },

  /** API-115 — replace the question, retire everything after it, stream a new answer. */
  async editResend(conversationId, messageId, slug, content) {
    const res = await endpoints.aiEditMessage(messageId, slug, content);
    set((st) => {
      const list = st.messages[conversationId] ?? [];
      const at = list.findIndex((m) => m.id === messageId);
      const kept = at >= 0 ? list.slice(0, at) : list;
      const next = [...kept, res.user_message, ...(res.assistant_message !== null ? [res.assistant_message] : [])];
      return { messages: { ...st.messages, [conversationId]: next }, streamTick: st.streamTick + 1 };
    });
    if (res.assistant_message !== null) {
      streamStore.seed(res.assistant_message);
    }
    void get().refreshStatus(slug);
  },

  async toggleSuperseded(conversationId, slug) {
    const include = !(get().supersededVisible[conversationId] ?? false);
    set((st) => ({ supersededVisible: { ...st.supersededVisible, [conversationId]: include } }));
    const page = await endpoints.aiMessages(conversationId, slug, { limit: 50, include_superseded: include });
    const ascending = [...page.messages].reverse(); // oldest → newest
    set((st) => ({
      messages: { ...st.messages, [conversationId]: ascending },
      hasMoreBefore: { ...st.hasMoreBefore, [conversationId]: page.has_more_before },
    }));
  },

  closeConversation() {
    set({ activeId: null });
  },

  setConsentOpen(open) {
    set({ consentOpen: open });
  },

  async giveConsent(slug) {
    await endpoints.aiConsent();
    await get().refreshStatus(slug);
    set({ consentOpen: false });
  },

  async applyEvent(event) {
    streamStore.apply(event);
    set((st) => ({ streamTick: st.streamTick + 1 }));

    switch (event.event) {
      case 'ai.message.completed':
        upsertMessage(get, event.message);
        // generating flag on the conversation list flips off
        set((st) => ({
          conversations: st.conversations.map((c) =>
            c.id === event.message.conversation_id
              ? { ...c, generating: event.message.status === 'pending' || event.message.status === 'streaming', message_count: c.message_count }
              : c,
          ),
        }));
        break;
      case 'ai.message.failed': {
        const list = get().messages[event.conversation_id];
        if (list !== undefined) {
          const at = list.findIndex((m) => m.id === event.message_id);
          if (at >= 0) {
            const next = list.map((m) => (m.id === event.message_id ? { ...m, status: 'failed' as const, error_code: event.error_code } : m));
            set((st) => ({ messages: { ...st.messages, [event.conversation_id]: next } }));
          }
        }
        break;
      }
      case 'ai.conversation.updated':
        set((st) => ({
          conversations: st.conversations.map((c) => (c.id === event.conversation_summary.id ? event.conversation_summary : c)),
        }));
        break;
      case 'ai.conversation.deleted':
        set((st) => ({ conversations: st.conversations.filter((c) => c.id !== event.conversation_id) }));
        break;
      case 'ai.message.delta': {
        const s = streamStore.get(event.message_id);
        if (s?.needsResync) {
          await resyncIfNeeded(event.message_id, get);
        }
        break;
      }
      default:
        break;
    }
  },

  activeStreamText(messageId) {
    const s = streamStore.get(messageId);
    if (s === undefined || s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') {
      return null;
    }
    return s.content;
  },
}));

/** route echo user-channel ai.* events into the store (wired in EchoProvider) */
export function handleAiEvent(event: AiStreamEvent): void {
  void useAiStore.getState().applyEvent(event);
}
