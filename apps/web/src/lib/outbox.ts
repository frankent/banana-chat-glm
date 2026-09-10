import { Outbox } from '@banana-chat/chat-core';
import { ApiError } from '@banana-chat/api-client';
import { endpoints } from './api';
import { roomCache } from './cache';
import { roomStore } from './room-stores';
import { queryClient } from './query-client';
import { useSession } from '../state/session';
import { registerSessionCleanup } from './session-resources';

const entries = new Map<string, { outbox: Outbox; ready: Promise<void> }>();
/** One persisted sender per user/workspace, survives navigation between rooms. */
export function sessionOutbox() {
  const { me, currentWorkspace } = useSession.getState();
  if (!me || !currentWorkspace) throw new Error('Sign in first');
  const scope = { userId: me.id, workspaceId: currentWorkspace.workspace.id };
  const key = `${scope.userId}:${scope.workspaceId}`;
  const existing = entries.get(key);
  if (existing) return existing;
  const slug = currentWorkspace.workspace.slug;
  const cache = roomCache(scope);
  const stores = new Map<string, ReturnType<typeof roomStore>>();
  const outbox = new Outbox(cache, {
    sender: async entry => {
      // Resolve the store only for this active scope; never write another account's state.
      if (useSession.getState().me?.id !== scope.userId) return { ok: false, retryable: false, error: 'Session changed' };
      if (useSession.getState().currentWorkspace?.workspace.id === scope.workspaceId) stores.set(entry.room_id, roomStore(entry.room_id));
      try {
        const res = await endpoints.sendMessage(entry.room_id, slug, entry.body, entry.client_message_id, undefined,
          entry.attachments.map(a => a.attachment_id!).filter(Boolean));
        return { ok: true, message: res.message };
      } catch (e) {
        return { ok: false, retryable: !(e instanceof ApiError && e.status < 500), error: e instanceof Error ? e.message : 'Send failed' };
      }
    },
    onDelivered: (entry, message) => {
      const store = stores.get(entry.room_id);
      store?.add(message);
      if (store) void cache.saveMessages(entry.room_id, store.getState().messages);
      void queryClient.invalidateQueries({ queryKey: ['rooms'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
  const ready = outbox.restore().then(() => outbox.setOnline(navigator.onLine));
  const result = { outbox, ready };
  entries.set(key, result);
  return result;
}
window.addEventListener('online', () => { for (const { outbox } of entries.values()) outbox.setOnline(true); });
window.addEventListener('offline', () => { for (const { outbox } of entries.values()) outbox.setOnline(false); });
registerSessionCleanup(async () => {
  const pending = [...entries.values()].map(({ outbox }) => outbox.dispose());
  entries.clear();
  await Promise.all(pending);
});
