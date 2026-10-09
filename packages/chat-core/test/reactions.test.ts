import { describe, expect, it } from 'vitest';
import type { Message } from '@banana-chat/shared';
import { MessageStore } from '../src/message-store.js';
import { applyReactionsChanged, canonicalReactionEmoji, compareEmoji, reactToMessage, sortReactions, toggleReaction } from '../src/reactions.js';
import { applyRoomEvent } from '../src/room-sync.js';

function msg(seq: number, o: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, room_id: 'r1', workspace_id: 'w1', sender_id: 'u1', sender: null, type: 'text', body: `m${seq}`, seq,
    client_message_id: `c${seq}`, reply_to: null, system_event: null, edited_at: null, edit_count: 0, deleted_at: null,
    delete_reason: null, created_at: new Date(2026, 0, 1, 0, 0, 0, seq).toISOString(), attachments: [], mentions: [], ...o,
  };
}
const store = (...m: Message[]) => { const s = new MessageStore('r1'); s.replace(m); return s; };

// TC-CORE-REACT-001
describe('toggleReaction', () => {
  it('adds, replaces and removes the single reaction', () => {
    const m = msg(1, { reactions: [{ emoji: '👍', count: 2 }], my_reaction: null });
    const a = toggleReaction(m, '👍');
    expect(a).toEqual({ reactions: [{ emoji: '👍', count: 3 }], my_reaction: '👍' });
    const b = toggleReaction({ ...m, ...a }, '❤️');
    expect(b).toEqual({ reactions: [{ emoji: '👍', count: 2 }, { emoji: '❤️', count: 1 }], my_reaction: '❤️' });
    const c = toggleReaction({ ...m, ...b }, '❤️');
    expect(c).toEqual({ reactions: [{ emoji: '👍', count: 2 }], my_reaction: null });
  });
  it('works on a message without reaction keys', () => {
    expect(toggleReaction(msg(1), '🔥')).toEqual({ reactions: [{ emoji: '🔥', count: 1 }], my_reaction: '🔥' });
  });
  it('canonicalises like the server so a picker value without FE0F still toggles off (DEC-098)', () => {
    expect(canonicalReactionEmoji('☕')).toBe('☕\uFE0F');
    expect(canonicalReactionEmoji('❤')).toBe('❤\uFE0F');
    expect(canonicalReactionEmoji('1\u20E3')).toBe('1\uFE0F\u20E3');
    expect(canonicalReactionEmoji('#\uFE0F\u20E3')).toBe('#\uFE0F\u20E3');
    for (const same of ['👍', '☕\uFE0F', '🇹🇭', '👍🏽', '👨‍👩‍👧‍👦']) expect(canonicalReactionEmoji(same)).toBe(same);
    const m = msg(1, { reactions: [{ emoji: '☕\uFE0F', count: 1 }], my_reaction: '☕\uFE0F' });
    expect(toggleReaction(m, '☕')).toEqual({ reactions: [], my_reaction: null });
  });
  it('orders count DESC then code point ASC', () => {
    expect(sortReactions([{ emoji: '😂', count: 1 }, { emoji: '👍', count: 1 }, { emoji: '🙏', count: 5 }]).map((r) => r.emoji)).toEqual(['🙏', '👍', '😂']);
    expect(compareEmoji('❤️', '👍')).toBeLessThan(0);
  });
});

// TC-CORE-REACT-002
describe('applyReactionsChanged / applyRoomEvent', () => {
  const evt = (o = {}) => ({ room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], actor_id: 'u2', actor_emoji: '👍', ...o });
  it('updates counts and keeps my_reaction when someone else acts', () => {
    const s = store(msg(1, { reactions: [], my_reaction: '❤️' }));
    applyReactionsChanged(s, evt(), 'me');
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 1 }], my_reaction: '❤️' });
  });
  it('follows actor_emoji when I am the actor (second device)', () => {
    const s = store(msg(1));
    applyRoomEvent(s, 'message.reactions_changed', evt({ actor_id: 'me', actor_emoji: null }), 'me');
    expect(s.getMessage('m1')?.my_reaction).toBeNull();
  });
  it('ignores unknown and deleted messages', () => {
    const s = store(msg(1, { deleted_at: '2026-01-01T00:00:00Z' }));
    applyReactionsChanged(s, evt(), 'me');
    applyReactionsChanged(s, evt({ message_id: 'nope' }), 'me');
    expect(s.getMessage('m1')?.reactions).toBeUndefined();
  });
  it('edit / page merges without reaction keys keep reactions', () => {
    const s = store(msg(1, { reactions: [{ emoji: '👍', count: 2 }], my_reaction: '👍' }));
    s.add(msg(1, { body: 'edited', edit_count: 1 }));
    expect(s.getMessage('m1')).toMatchObject({ body: 'edited', my_reaction: '👍', reactions: [{ emoji: '👍', count: 2 }] });
  });
  it('markDeleted clears reactions', () => {
    const s = store(msg(1, { reactions: [{ emoji: '👍', count: 2 }], my_reaction: '👍' }));
    s.markDeleted('m1', '2026-01-01T00:00:00Z', 'sender');
    expect(s.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
  });
});

// TC-CORE-REACT-003
describe('reactToMessage', () => {
  it('is optimistic, protects against stale pages, reconciles from the response', async () => {
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    let release!: (v: { message_id: string; reactions: { emoji: string; count: number }[]; my_reaction: string | null }) => void;
    const gate = new Promise<Parameters<typeof release>[0]>((r) => { release = r; });
    const p = reactToMessage(s, 'm1', '👍', { set: () => gate, clear: () => gate });
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    s.mergePage([msg(1, { reactions: [], my_reaction: null })]);
    applyReactionsChanged(s, { room_id: 'r1', message_id: 'm1', reactions: [], actor_id: 'x', actor_emoji: null }, 'me');
    expect(s.getMessage('m1')?.my_reaction).toBe('👍');
    expect(await reactToMessage(s, 'm1', '❤️', { set: () => gate, clear: () => gate })).toBe(false);
    release({ message_id: 'm1', reactions: [{ emoji: '👍', count: 4 }], my_reaction: '👍' });
    await p;
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 4 }], my_reaction: '👍' });
    expect(s.isReactionPending('m1')).toBe(false);
  });
  it('a page requested before the reaction landed cannot overwrite it afterwards', async () => {
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    const fetchedAt = Date.now() - 5;
    await reactToMessage(s, 'm1', '👍', { set: async () => ({ message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }), clear: () => Promise.reject(new Error('x')) });
    s.mergePage([msg(1, { reactions: [], my_reaction: null })], fetchedAt);
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    s.add([msg(1, { reactions: [], my_reaction: null })], fetchedAt);
    s.fillDelivered([msg(1, { reactions: [], my_reaction: null })], fetchedAt);
    s.confirmClientMessage('cid-none', msg(1, { reactions: [], my_reaction: null }), fetchedAt);
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    s.mergePage([msg(1, { reactions: [{ emoji: '👍', count: 2 }], my_reaction: '👍' })], Date.now() + 5);
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 2 }], my_reaction: '👍' });
  });
  it('rolls back and rethrows on error', async () => {
    const s = store(msg(1, { reactions: [{ emoji: '❤️', count: 1 }], my_reaction: '❤️' }));
    const boom = () => Promise.reject(new Error('422'));
    await expect(reactToMessage(s, 'm1', '👍', { set: boom, clear: boom })).rejects.toThrow('422');
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '❤️', count: 1 }], my_reaction: '❤️' });
    expect(s.isReactionPending('m1')).toBe(false);
  });
  it('removes via clear() when tapping my own emoji', async () => {
    const s = store(msg(1, { reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }));
    let cleared = false;
    await reactToMessage(s, 'm1', '👍', { set: () => Promise.reject(new Error('x')), clear: async () => { cleared = true; return { message_id: 'm1', reactions: [], my_reaction: null }; } });
    expect(cleared).toBe(true);
    expect(s.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
  });
  it('refetches counts when an event was withheld during the request (success and rollback)', async () => {
    const evt = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 9 }], actor_id: 'x', actor_emoji: '🔥' };
    const fresh = [{ emoji: '🔥', count: 9 }, { emoji: '👍', count: 1 }];
    const counts = async () => fresh;

    const ok = store(msg(1, { reactions: [], my_reaction: null }));
    const done = reactToMessage(ok, 'm1', '👍', {
      set: async () => { applyReactionsChanged(ok, evt, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
      clear: () => Promise.reject(new Error('x')),
      counts,
    });
    await done;
    expect(ok.getMessage('m1')).toMatchObject({ reactions: fresh, my_reaction: '👍' });

    const bad = store(msg(1, { reactions: [], my_reaction: null }));
    const boom = async () => { applyReactionsChanged(bad, evt, 'me'); throw new Error('422'); };
    await expect(reactToMessage(bad, 'm1', '👍', { set: boom, clear: boom, counts })).rejects.toThrow('422');
    expect(bad.getMessage('m1')).toMatchObject({ reactions: fresh, my_reaction: null });
    expect(bad.isReactionPending('m1')).toBe(false);
  });
  it('a counts refetch that races a newer event or tap does not restore the older snapshot', async () => {
    const withheld = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 9 }], actor_id: 'x', actor_emoji: '🔥' };
    const newer = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 12 }], actor_id: 'y', actor_emoji: '🔥' };
    const old = [{ emoji: '🔥', count: 9 }];

    const s = store(msg(1, { reactions: [], my_reaction: null }));
    await reactToMessage(s, 'm1', '👍', {
      set: async () => { applyReactionsChanged(s, withheld, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
      clear: () => Promise.reject(new Error('x')),
      counts: async () => { applyReactionsChanged(s, newer, 'me'); return old; }, // the event lands while the GET is in flight
    });
    expect(s.getMessage('m1')?.reactions).toEqual([{ emoji: '🔥', count: 12 }]);

    const t = store(msg(1, { reactions: [], my_reaction: null }));
    let tapped: Promise<boolean> | null = null;
    await reactToMessage(t, 'm1', '👍', {
      set: async () => { applyReactionsChanged(t, withheld, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
      clear: async () => ({ message_id: 'm1', reactions: [], my_reaction: null }),
      counts: async () => {
        tapped = reactToMessage(t, 'm1', '👍', { set: () => new Promise(() => {}), clear: () => new Promise(() => {}) }); // next tap: optimistic, in flight
        return old;
      },
    });
    expect(tapped).not.toBeNull();
    expect(t.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null }); // optimistic removal kept, snapshot dropped
  });
  it('a counts refetch that races a newer REST page merge does not restore the older snapshot', async () => {
    const withheld = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 9 }], actor_id: 'x', actor_emoji: '🔥' };
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    await reactToMessage(s, 'm1', '👍', {
      set: async () => { applyReactionsChanged(s, withheld, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
      clear: () => Promise.reject(new Error('x')),
      counts: async () => {
        // a page requested after the reaction landed merges while the older counts GET is still in flight
        s.mergePage([msg(1, { reactions: [{ emoji: '🔥', count: 12 }], my_reaction: '👍' })], Date.now() + 5);
        return [{ emoji: '🔥', count: 9 }];
      },
    });
    expect(s.getMessage('m1')?.reactions).toEqual([{ emoji: '🔥', count: 12 }]);
  });
  it('replace() follows the same freshness rule as a page merge (FR-MSG-012)', async () => {
    const withheld = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 9 }], actor_id: 'x', actor_emoji: '🔥' };
    const run = async (fetchedAtOffset: number) => {
      const s = store(msg(1, { reactions: [], my_reaction: null }));
      await reactToMessage(s, 'm1', '👍', {
        set: async () => { applyReactionsChanged(s, withheld, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
        clear: () => Promise.reject(new Error('x')),
        counts: async () => {
          s.replace([msg(1, { reactions: [{ emoji: '🔥', count: 9 }], my_reaction: '👍' })], Date.now() + fetchedAtOffset);
          return [{ emoji: '🔥', count: 12 }];
        },
      });
      return s.getMessage('m1')?.reactions;
    };
    // a page fetched before the reaction landed is stale: it keeps the local summary, so the fresher counts win
    expect(await run(-5)).toEqual([{ emoji: '🔥', count: 12 }]);
    // a page fetched after the reaction landed is newer: it wins and the older counts snapshot is dropped
    const fresh = store(msg(1, { reactions: [], my_reaction: null }));
    await reactToMessage(fresh, 'm1', '👍', {
      set: async () => { applyReactionsChanged(fresh, withheld, 'me'); return { message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }; },
      clear: () => Promise.reject(new Error('x')),
      counts: async () => {
        fresh.replace([msg(1, { reactions: [{ emoji: '🔥', count: 12 }], my_reaction: '👍' })], Date.now() + 5);
        return [{ emoji: '🔥', count: 9 }];
      },
    });
    expect(fresh.getMessage('m1')?.reactions).toEqual([{ emoji: '🔥', count: 12 }]);
  });
  it('replace() keeps the optimistic summary of a row whose request is pending', () => {
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    void reactToMessage(s, 'm1', '👍', { set: () => new Promise(() => {}), clear: () => new Promise(() => {}) });
    s.replace([msg(1, { reactions: [{ emoji: '❤️', count: 3 }], my_reaction: null }), msg(2)], Date.now() + 5);
    expect(s.getMessage('m1')).toMatchObject({ reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    expect(s.getMessage('m2')).toBeDefined();
  });
  it('a tombstone from a REST page wins over a pending or newer local summary (FR-MSG-012 f)', () => {
    const gone = (extra: Partial<Message> = {}) => msg(1, { deleted_at: '2026-10-09T00:00:00Z', delete_reason: 'sender', body: null, attachments: [], ...extra });
    const pending = store(msg(1, { reactions: [], my_reaction: null }));
    void reactToMessage(pending, 'm1', '👍', { set: () => new Promise(() => {}), clear: () => new Promise(() => {}) });
    pending.add(gone({ reactions: [], my_reaction: null }), Date.now() + 5);
    expect(pending.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
    expect(pending.getMessage('m1')?.deleted_at).toBeTruthy();

    const touched = store(msg(1, { reactions: [], my_reaction: null }));
    touched.setReactions('m1', [{ emoji: '🔥', count: 2 }], '🔥');
    touched.mergePage([gone()], Date.now() - 5); // stale page, tombstone carries no reaction keys
    expect(touched.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
  });
  it('a tombstone wins even when its edit_count is lower than the loaded row (delete is terminal)', () => {
    const edited = () => msg(1, { edit_count: 2, reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    const gone = () => msg(1, { edit_count: 1, deleted_at: '2026-10-09T00:00:00Z', delete_reason: 'sender', body: null, attachments: [] });
    for (const apply of [(s: MessageStore) => s.add(gone()), (s: MessageStore) => s.replace([gone()])]) {
      const s = store(edited());
      apply(s);
      expect(s.getMessage('m1')?.deleted_at).toBeTruthy();
      expect(s.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
    }
  });
  it('re-delivering a tombstone does not bump the reaction version (summary already cleared)', () => {
    const s = store(msg(1, { reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }));
    s.markDeleted('m1', '2026-10-09T00:00:00Z', 'sender');
    const version = s.reactionVersion('m1');
    s.add(msg(1, { deleted_at: '2026-10-09T00:00:00Z', delete_reason: 'sender', body: null, attachments: [] }));
    expect(s.reactionVersion('m1')).toBe(version);
  });
  it('replace() and a page merge both refuse to revive a deleted message', () => {
    const live = () => msg(1, { reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' });
    for (const apply of [(s: MessageStore) => s.replace([live()]), (s: MessageStore) => s.mergePage([live()])]) {
      const s = store(msg(1, { reactions: [], my_reaction: null }));
      s.markDeleted('m1', '2026-10-09T00:00:00Z', 'sender');
      apply(s);
      expect(s.getMessage('m1')?.deleted_at).toBeTruthy();
      expect(s.getMessage('m1')).toMatchObject({ reactions: [], my_reaction: null });
    }
  });
  it('sends the canonical emoji to the API and removes via clear() when the stored copy carries FE0F', async () => {
    const sent: string[] = [];
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    const state = (e: string | null) => ({ message_id: 'm1', reactions: e === null ? [] : [{ emoji: e, count: 1 }], my_reaction: e });
    const api = { set: async (e: string) => { sent.push(e); return state(e); }, clear: async () => { sent.push('clear'); return state(null); } };
    await reactToMessage(s, 'm1', '☕', api);
    await reactToMessage(s, 'm1', '☕', api);
    expect(sent).toEqual(['☕\uFE0F', 'clear']);
  });
  it('skips the counts refetch when the only withheld event is our own echo, but not when any withheld event differs', async () => {
    const mine = [{ emoji: '👍', count: 1 }];
    const echo = { room_id: 'r1', message_id: 'm1', reactions: mine, actor_id: 'me', actor_emoji: '👍' };
    const other = { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '🔥', count: 4 }, { emoji: '👍', count: 1 }], actor_id: 'x', actor_emoji: '🔥' };
    const run = async (events: (typeof echo)[]) => {
      const s = store(msg(1, { reactions: [], my_reaction: null }));
      let fetched = 0;
      await reactToMessage(s, 'm1', '👍', {
        set: async () => { for (const e of events) applyReactionsChanged(s, e, 'me'); return { message_id: 'm1', reactions: mine, my_reaction: '👍' }; },
        clear: () => Promise.reject(new Error('x')),
        counts: async () => { fetched++; return other.reactions; },
      });
      return { fetched, reactions: s.getMessage('m1')?.reactions };
    };
    expect(await run([echo])).toEqual({ fetched: 0, reactions: mine });
    expect(await run([echo, echo])).toEqual({ fetched: 0, reactions: mine });
    expect(await run([other])).toEqual({ fetched: 1, reactions: other.reactions });
    expect(await run([other, echo])).toEqual({ fetched: 1, reactions: other.reactions }); // out-of-order delivery: the echo must not hide the other actor
  });
  it('always refetches after a failed request that withheld an event, even an identical one', async () => {
    const s = store(msg(1, { reactions: [{ emoji: '👍', count: 1 }], my_reaction: null }));
    let fetched = 0;
    const boom = async () => { applyReactionsChanged(s, { room_id: 'r1', message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], actor_id: 'x', actor_emoji: '👍' }, 'me'); throw new Error('422'); };
    await expect(reactToMessage(s, 'm1', '🔥', { set: boom, clear: boom, counts: async () => { fetched++; return [{ emoji: '👍', count: 1 }]; } })).rejects.toThrow('422');
    expect(fetched).toBe(1);
  });
  it('does not refetch when no event was withheld', async () => {
    const s = store(msg(1, { reactions: [], my_reaction: null }));
    let fetched = 0;
    await reactToMessage(s, 'm1', '👍', {
      set: async () => ({ message_id: 'm1', reactions: [{ emoji: '👍', count: 1 }], my_reaction: '👍' }),
      clear: () => Promise.reject(new Error('x')),
      counts: async () => { fetched++; return []; },
    });
    expect(fetched).toBe(0);
  });
});
