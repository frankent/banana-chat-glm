import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EventEnvelope } from '@banana-chat/shared';
import { TypingState } from '@banana-chat/chat-core';
import { useEcho } from '../echo/EchoProvider';

export function useRoomTools(roomId: string | undefined, slug: string | undefined, me: string | undefined) {
  const {echo} = useEcho();
  const client = useQueryClient();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    setNames([]);
    if (!echo || !roomId || !slug || !me) return;
    const state = new TypingState(me);
    const channel = echo.private(`room.${roomId}`);
    const typing = (e: EventEnvelope<{user_id:string; display_name:string; typing:boolean}>) => {state.receive(e.data.user_id, e.data.display_name, e.data.typing);setNames(state.names());};
    const notes = () => {void client.invalidateQueries({queryKey:['notes', slug, roomId]});};
    const pins = () => {void client.invalidateQueries({queryKey:['pins', slug, roomId]});};
    channel.listen('.room.typing', typing).listen('.room.notes_changed', notes).listen('.room.pins_changed', pins).listen('.message.deleted', pins).listen('.message.updated', pins);
    const timer = setInterval(() => setNames(state.names()), 1000);
    return () => {
      clearInterval(timer);
      channel.stopListening('.room.typing', typing).stopListening('.room.notes_changed', notes).stopListening('.room.pins_changed', pins).stopListening('.message.deleted', pins).stopListening('.message.updated', pins);
    };
  }, [echo, roomId, slug, me, client]);
  return names;
}
