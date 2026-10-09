import type { Message, ReactionCount, ReactionState, ReactionsChangedEvent } from '@banana-chat/shared';
import type { MessageStore } from './message-store.js';

/** Code-point order — identical to the server's `strcmp` on UTF-8 bytes. */
export function compareEmoji(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** count DESC, emoji ASC — the server's order, so chips never reshuffle. */
export function sortReactions(reactions: ReactionCount[]): ReactionCount[] {
  return [...reactions].sort((a, b) => b.count - a.count || compareEmoji(a.emoji, b.emoji));
}

/**
 * DEC-098 — the server stores a canonical form (a lone BMP symbol gets FE0F, a
 * keycap always carries FE0F). Mirror both rules so a picker value like "☕"
 * still matches the stored "☕️" and the second tap removes instead of re-setting.
 */
export function canonicalReactionEmoji(emoji: string): string {
  const keycap = /^([0-9#*])️?⃣$/u.exec(emoji);
  if (keycap !== null) return `${keycap[1]}️⃣`;
  const cp = emoji.codePointAt(0);
  if (cp !== undefined && cp < 0x1f000 && emoji.length === 1) return `${emoji}️`;
  return emoji;
}

/**
 * FR-MSG-012 — optimistic next state. One reaction per user: a new emoji
 * replaces the old one; tapping your current emoji removes it.
 */
export function toggleReaction(
  message: Pick<Message, 'reactions' | 'my_reaction'>,
  rawEmoji: string,
): { reactions: ReactionCount[]; my_reaction: string | null } {
  const emoji = canonicalReactionEmoji(rawEmoji);
  const mine = message.my_reaction ?? null;
  const counts = new Map<string, number>();
  for (const r of message.reactions ?? []) counts.set(r.emoji, r.count);
  if (mine !== null) {
    const left = (counts.get(mine) ?? 1) - 1;
    if (left > 0) counts.set(mine, left);
    else counts.delete(mine);
  }
  const next = mine === emoji ? null : emoji;
  if (next !== null) counts.set(next, (counts.get(next) ?? 0) + 1);
  return {
    reactions: sortReactions([...counts].map(([e, count]) => ({ emoji: e, count }))),
    my_reaction: next,
  };
}

/**
 * EVT-089 — merge another client's (or our own echoed) change. The event
 * carries no per-viewer data, so `my_reaction` only follows `actor_emoji`
 * when WE are the actor (second device). Skipped while our own request is
 * in flight; its response reconciles, and `reactToMessage` refetches the counts
 * afterwards when a withheld event differs from that response (our own echo does not).
 */
export function applyReactionsChanged(store: MessageStore, evt: ReactionsChangedEvent, meId?: string): void {
  if (store.isReactionPending(evt.message_id)) {
    store.markReactionDirty(evt.message_id, sortReactions(evt.reactions));
    return;
  }
  store.setReactions(
    evt.message_id,
    sortReactions(evt.reactions),
    meId !== undefined && evt.actor_id === meId ? evt.actor_emoji : undefined,
  );
}

export interface ReactionApi {
  set(emoji: string): Promise<ReactionState>;
  clear(): Promise<ReactionState>;
  /** Fresh counts, used once after a request during which an event was withheld. */
  counts?(): Promise<ReactionCount[]>;
}

/**
 * FR-MSG-012 — tap handler shared by every client: optimistic update, call
 * the API, reconcile with the response, roll back on error. A tap while a
 * request for the same message is in flight is dropped (returns false).
 */
export async function reactToMessage(store: MessageStore, messageId: string, rawEmoji: string, api: ReactionApi): Promise<boolean> {
  const emoji = canonicalReactionEmoji(rawEmoji);
  const message = store.getMessage(messageId);
  if (message === undefined || message.deleted_at) return false;
  if (!store.beginReaction(messageId)) return false;
  const previous = { reactions: message.reactions ?? [], my_reaction: message.my_reaction ?? null };
  const next = toggleReaction(message, emoji);
  store.setReactions(messageId, next.reactions, next.my_reaction);
  try {
    const state = await (next.my_reaction === null ? api.clear() : api.set(emoji));
    const withheld = store.endReaction(messageId);
    const settled = sortReactions(state.reactions);
    store.setReactions(messageId, settled, state.my_reaction);
    if (withheld !== null && withheld.some((counts) => !sameCounts(counts, settled))) await refreshCounts(store, messageId, api);
    return true;
  } catch (error) {
    const withheld = store.endReaction(messageId);
    store.setReactions(messageId, previous.reactions, previous.my_reaction);
    if (withheld !== null) await refreshCounts(store, messageId, api);
    throw error;
  }
}

function sameCounts(a: ReactionCount[], b: ReactionCount[]): boolean {
  return a.length === b.length && a.every((x, i) => x.emoji === b[i]!.emoji && x.count === b[i]!.count);
}

/**
 * Best effort: a failed refetch leaves the reconciled state in place. A summary
 * written while the request was in flight (a newer event, or the user's next tap)
 * is newer than this snapshot, so the snapshot is dropped.
 */
async function refreshCounts(store: MessageStore, messageId: string, api: ReactionApi): Promise<void> {
  if (api.counts === undefined || store.isReactionPending(messageId)) return;
  const version = store.reactionVersion(messageId);
  try {
    const counts = sortReactions(await api.counts());
    if (store.reactionVersion(messageId) === version && !store.isReactionPending(messageId)) store.setReactions(messageId, counts);
  } catch {
    /* keep the reconciled state */
  }
}
