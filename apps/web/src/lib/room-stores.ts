import { useSession } from '../state/session';
import { registerSessionCleanup } from './session-resources';
import { MessageStore } from '@banana-chat/chat-core';
import type { MessageStoreState } from '@banana-chat/chat-core';
import { useEffect, useSyncExternalStore } from 'react';

interface RoomEntry {
  store: MessageStore;
  listeners: Set<() => void>;
  snapshot: MessageStoreState;
}

const entries = new Map<string, RoomEntry>();

function entryFor(roomId: string): RoomEntry {
  const { me, currentWorkspace } = useSession.getState();
  const key = `${me?.id ?? 'anonymous'}:${currentWorkspace?.workspace.id ?? ''}:${roomId}`;
  let entry = entries.get(key);
  if (entry === undefined) {
    const listeners = new Set<() => void>();
    const store = new MessageStore(roomId, 10_000, (state) => {
      entry!.snapshot = state;
      for (const listener of listeners) {
        listener();
      }
    });
    entry = { store, listeners, snapshot: store.getState() };
    entries.set(key, entry);
  }
  return entry;
}

export function roomStore(roomId: string): MessageStore {
  return entryFor(roomId).store;
}

/**
 * FR-ROOM-012 — dispose one room's in-memory store (secret expiry / room
 * deletion): the entries map and the store's listeners must not outlive the
 * room, or a stale snapshot could re-render (and re-seed) its messages.
 */
export function disposeRoomStore(scope: { userId: string; workspaceId: string }, roomId: string): void {
  const key = `${scope.userId}:${scope.workspaceId}:${roomId}`;
  const entry = entries.get(key);
  if (entry !== undefined) {
    entry.store.dispose();
    entries.delete(key);
  }
}

registerSessionCleanup(() => {
  for (const entry of entries.values()) entry.store.dispose();
  entries.clear();
});

const EMPTY_STATE: MessageStoreState = { messages: [], needsFill: null, fillTimedOut: false, prependCount: 0 };

/** React binding — one store per room, re-render on every emit. */
export function useMessageStore(roomId: string | undefined): MessageStoreState {
  useEffect(() => () => {
    if (roomId !== undefined) {
      roomStore(roomId).dispose();
    }
  }, [roomId]);

  return useSyncExternalStore(
    (onStoreChange) => {
      if (roomId === undefined) {
        return () => {};
      }
      const entry = entryFor(roomId);
      entry.listeners.add(onStoreChange);
      return () => {
        entry.listeners.delete(onStoreChange);
      };
    },
    () => (roomId === undefined ? EMPTY_STATE : entryFor(roomId).snapshot),
  );
}
