import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Message } from '@banana-chat/shared';
import { registerSessionCleanup } from '../lib/session-resources';

type Anchor = { seq: number; offset: number; bottom: boolean };
const positions = new Map<string, Anchor>();
registerSessionCleanup(() => { positions.clear(); });
export function forgetChatPosition(scope: string) { positions.delete(scope); }

/** FR-UI-ML: anchor to a message, not the total height (which includes new arrivals). */
export function useChatScroll({ scope, listRef, contentRef, messages, pendingCount, userId, anchorMode }: {
  scope: string; listRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null>;
  messages: Message[]; pendingCount: number; userId: string | undefined; anchorMode: boolean;
}) {
  const anchor = useRef<Anchor | null>(null);
  const anchorModeRef = useRef(anchorMode);
  useLayoutEffect(() => { anchorModeRef.current = anchorMode; }, [anchorMode]);
  const bottom = useRef(true);
  const latestRequested = useRef(false);
  const initialized = useRef(false);
  const unseen = useRef(new Set<string>());
  const [away, setAway] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const capture = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll<HTMLElement>('[data-seq]')].find(el => el.getBoundingClientRect().bottom > top + 1);
    if (row) {
      anchor.current = { seq: Number(row.dataset.seq), offset: row.getBoundingClientRect().top - top, bottom: bottom.current };
      if (!anchorMode) positions.set(scope, anchor.current);
    }
  }, [listRef, scope, anchorMode]);

  const restore = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (bottom.current && !anchorMode) list.scrollTop = list.scrollHeight;
    else if (anchor.current) {
      const row = list.querySelector<HTMLElement>(`[data-seq="${anchor.current.seq}"]`);
      if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.current.offset;
    }
    capture();
  }, [listRef, anchorMode, capture]);

  useLayoutEffect(() => {
    anchor.current = positions.get(scope) ?? null;
    bottom.current = anchor.current?.bottom ?? true;
    initialized.current = false;
    latestRequested.current = false;
    unseen.current.clear();
    setNewCount(0);
    setAway(!bottom.current);
  }, [scope]);

  useLayoutEffect(() => {
    if (!messages.length && !pendingCount) return;
    initialized.current = true;
    // Apply the explicit latest intent after the URL/outbox DOM commit as well.
    // A queued scroll event from the old anchored viewport must not cancel it.
    if (latestRequested.current && !anchorMode) {
      bottom.current = true;
      latestRequested.current = false;
    }
    restore();
  }, [messages, pendingCount, anchorMode, restore, userId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content) return;
    // Images, edited text, fonts and composer/viewport resize can change height
    // without changing message count. Browser anchoring is disabled for this list.
    const observer = new ResizeObserver(() => { if (initialized.current) restore(); });
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [listRef, contentRef, restore]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    bottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    setAway(!bottom.current);
    if (bottom.current && !anchorMode) { unseen.current.clear(); setNewCount(0); }
    capture();
  }, [listRef, capture, anchorMode]);

  const toLatest = useCallback(() => {
    latestRequested.current = anchorMode;
    bottom.current = true;
    unseen.current.clear();
    setNewCount(0);
    setAway(false);
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    capture();
  }, [listRef, capture, anchorMode]);

  // Only live arrivals count. Loading a later search/history page is not an arrival.
  const onIncoming = useCallback((message: Message) => {
    if (initialized.current && (!bottom.current || anchorModeRef.current) && message.sender_id !== userId && message.type !== 'system') {
      unseen.current.add(message.id);
      setNewCount(unseen.current.size);
    }
  }, [userId]);

  return { onScroll, toLatest, away, newCount, capture, restore, onIncoming };
}
