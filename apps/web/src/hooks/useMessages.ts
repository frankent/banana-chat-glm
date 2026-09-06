import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Message } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { roomStore } from '../lib/room-stores';

/**
 * TASK-WEB-005 — initial page seeds the store; older pages prepend via add().
 * The store is the only source of truth for rendering (useMessageStore).
 */
export function useMessagePage(roomId: string | undefined, slug: string | undefined) {
  const queryClient = useQueryClient();
  const seededRoom = useRef<string | undefined>(undefined);

  const query = useQuery({
    queryKey: ['messages', roomId, 'latest'],
    queryFn: async () => {
      const page = await endpoints.messages(roomId!, slug!);
      roomStore(roomId!).replace(page.messages);
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

export function optimisticMessage(roomId: string, workspaceId: string, senderId: string, body: string, clientMessageId: string, seq: number): Message {
  return {
    id: `optimistic-${clientMessageId}`,
    room_id: roomId,
    workspace_id: workspaceId,
    sender_id: senderId,
    sender: null,
    type: 'text',
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
    attachments: [],
  };
}
