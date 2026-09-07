import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Attachment, Message } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { roomCache } from '../lib/cache';
import { roomStore } from '../lib/room-stores';
import { useSession } from '../state/session';

/**
 * TASK-WEB-005 — initial page seeds the store; older pages prepend via add().
 * The store is the only source of truth for rendering (useMessageStore).
 *
 * TASK-WEB-016 — the newest 50 rows/room persist to IndexedDB and hydrate
 * the store before the network answers (prependCount keeps scroll anchored).
 */
export function useMessagePage(roomId: string | undefined, slug: string | undefined) {
  const queryClient = useQueryClient();
  const seededRoom = useRef<string | undefined>(undefined);
  const me = useSession((s) => s.me);
  const workspace = useSession((s) => s.currentWorkspace);

  const query = useQuery({
    queryKey: ['messages', roomId, 'latest'],
    queryFn: async () => {
      const page = await endpoints.messages(roomId!, slug!);
      roomStore(roomId!).replace(page.messages);
      if (me !== null && workspace !== null) {
        void roomCache({ userId: me.id, workspaceId: workspace.workspace.id }).saveMessages(roomId!, page.messages);
      }
      return page;
    },
    enabled: roomId !== undefined && slug !== undefined,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

  // reseed when the room changes back to one already cached by react-query
  useEffect(() => {
    if (query.data !== undefined && seededRoom.current !== roomId) {
      seededRoom.current = roomId;
      roomStore(roomId!).replace(query.data.messages);
    }
  }, [roomId, query.data]);

  // hydrate from IndexedDB while the request is in flight (WEB-016)
  useEffect(() => {
    if (roomId === undefined || me === null || workspace === null || seededRoom.current === roomId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = await roomCache({ userId: me.id, workspaceId: workspace.workspace.id }).loadMessages(roomId);
      if (!cancelled && cached !== null && cached.length > 0 && seededRoom.current !== roomId) {
        roomStore(roomId).replace(cached);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, me?.id, workspace?.workspace.id]);

  const loadOlder = async (): Promise<boolean> => {
    if (roomId === undefined || slug === undefined) {
      return false;
    }
    const store = roomStore(roomId);
    const oldest = store.getState().messages[0]?.seq;
    if (oldest === undefined || oldest <= 1) {
      return false;
    }
    const page = await endpoints.messages(roomId, slug, { before_seq: oldest, limit: 50 });
    store.add(page.messages);
    if (me !== null && workspace !== null) {
      const merged = store.getState().messages;
      void roomCache({ userId: me.id, workspaceId: workspace.workspace.id }).saveMessages(roomId, merged);
    }
    return page.has_more_before;
  };

  const fillGap = async (afterSeq: number, beforeSeq: number) => {
    if (roomId === undefined || slug === undefined) {
      return;
    }
    const page = await endpoints.messages(roomId, slug, { after_seq: afterSeq, limit: beforeSeq - afterSeq - 1 });
    roomStore(roomId).fillDelivered(page.messages);
  };

  const refetchStatus = () => {
    if (roomId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['read-status', roomId] });
    }
  };

  return { query, loadOlder, fillGap, refetchStatus };
}

export function optimisticMessage(
  roomId: string,
  workspaceId: string,
  senderId: string,
  body: string | null,
  clientMessageId: string,
  seq: number,
  attachments: Attachment[] = [],
): Message {
  return {
    id: `optimistic-${clientMessageId}`,
    room_id: roomId,
    workspace_id: workspaceId,
    sender_id: senderId,
    sender: null,
    type: attachments.length === 0 ? 'text' : attachments.every((a) => a.kind === 'image') ? 'image' : attachments.every((a) => a.kind === 'video') ? 'video' : 'file',
    body,
    // contiguous with the tail so gap-fill logic doesn't withhold it
    seq,
    client_message_id: clientMessageId,
    reply_to: null,
    system_event: null,
    edited_at: null,
    edit_count: 0,
    deleted_at: null,
    delete_reason: null,
    created_at: new Date().toISOString(),
    mentions: [],
    attachments,
  };
}
