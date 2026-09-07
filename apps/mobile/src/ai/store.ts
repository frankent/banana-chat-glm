import { create } from 'zustand';
import type { AiConversationSummary, AiMessage, AiStatus, AiStreamEvent } from '@banana-chat/shared';
import { createAiStreamStore } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';
import { aiCache } from '../auth/session';

/**
 * TASK-MOB-015/016 — mobile AI state: conversation list + messages cached in
 * SQLite (TC-MOB-056), streaming through chat-core's AiStreamStore over Echo,
 * resync-on-gap, and focus pings so ai_completed push is suppressed while
 * the conversation is open (API-118).
 */
const streamStore = createAiStreamStore();

function uuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface AiState {
  status: AiStatus | null;
  statusError: string | null;
  conversations: AiConversationSummary[];
  activeId: string | null;
  messages: Record<string, AiMessage[]>;
  sending: boolean;
  streamTick: number;
  consentOpen: boolean;

  refreshStatus: (slug: string) => Promise<void>;
  loadConversations: (slug: string) => Promise<void>;
  open: (conversationId: string, slug: string) => Promise<void>;
  newConversation: (slug: string) => Promise<string | null>;
  send: (conversationId: string, slug: string, content: string) => Promise<void>;
  cancel: (messageId: string, slug: string) => Promise<void>;
  retry: (conversationId: string, slug: string, content: string) => Promise<void>;
  closeConversation: () => void;
  setConsentOpen: (open: boolean) => void;
  giveConsent: (slug: string) => Promise<void>;
  applyEvent: (event: AiStreamEvent) => Promise<void>;
  activeStreamText: (messageId: string) => string | null;
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

/** TC-MOB-052 — coming back from background mid-stream: refetch and resume */
async function resyncIfNeeded(messageId: string, get: () => AiState): Promise<void> {
  const s = streamStore.get(messageId);
  if (s === undefined || !s.needsResync) {
    return;
  }
  try {
    const res = await endpoints.aiShowMessage(messageId);
    streamStore.resync(messageId, res.partial_content, res.last_index, res.message);
    useAiStore.setState((st) => ({ streamTick: st.streamTick + 1 }));
    if (res.message.status !== 'pending' && res.message.status !== 'streaming') {
      upsertMessage(get, res.message);
    }
  } catch {
    // network hiccup — the next gap/event retries
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  status: null,
  statusError: null,
  conversations: [],
  activeId: null,
  messages: {},
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
    const cache = aiCache();
    if (cache !== null && get().conversations.length === 0) {
      const cached = await cache.loadConversations();
      if (cached !== null && get().conversations.length === 0) {
        set({ conversations: cached });
      }
    }
    try {
      const res = await endpoints.aiConversations(slug);
      set({ conversations: res.conversations });
      void cache?.saveConversations(res.conversations);
    } catch {
      // offline: the cached list stays on screen
    }
  },

  async open(conversationId, slug) {
    set({ activeId: conversationId });
    if (get().messages[conversationId] === undefined) {
      const cache = aiCache();
      const cached = await cache?.loadMessages(conversationId);
      if (cached !== null && cached !== undefined && get().messages[conversationId] === undefined) {
        set((st) => ({ messages: { ...st.messages, [conversationId]: cached } }));
      }
      const page = await endpoints.aiMessages(conversationId, slug, { limit: 50 });
      set((st) => ({ messages: { ...st.messages, [conversationId]: page.messages } }));
      void cache?.saveMessages(conversationId, page.messages);
    }
    void endpoints.aiFocus(conversationId, slug, true).catch(() => undefined);
  },

  async newConversation(slug) {
    const res = await endpoints.aiCreateConversation(slug);
    const conversation = res.conversation;
    set((st) => ({
      conversations: [conversation, ...st.conversations],
      messages: { ...st.messages, [conversation.id]: [] },
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
      void aiCache()?.saveMessages(conversationId, merged);
      if (res.assistant_message !== null) {
        streamStore.seed(res.assistant_message);
      }
    } finally {
      set({ sending: false });
    }
  },

  async cancel(messageId, slug) {
    try {
      const res = await endpoints.aiCancel(messageId, slug);
      upsertMessage(get, res.message);
    } catch {
      // 409 race: the job finished first — the completion event wins
    }
  },

  async retry(conversationId, slug, content) {
    const list = get().messages[conversationId] ?? [];
    const failed = [...list].reverse().find((m) => m.status === 'failed');
    if (failed !== undefined && failed.parent_message_id !== null) {
      set((st) => ({
        messages: {
          ...st.messages,
          [conversationId]: (st.messages[conversationId] ?? []).filter((m) => m.id !== failed.id && m.id !== failed.parent_message_id),
        },
      }));
    }
    await get().send(conversationId, slug, content);
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

export function handleAiEvent(event: AiStreamEvent): void {
  void useAiStore.getState().applyEvent(event);
}
