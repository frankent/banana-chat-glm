import { describe, expect, it, jest } from '@jest/globals';
import type { RoomListItem } from '@banana-chat/shared';
import { ProfileDmFlow, resolveRoomType, type DmFlowDeps, type DmFlowSnapshot } from '../dm-flow';

const item = (id: string, type: string, other: string | null, secret = false) =>
  ({ room: { id, type, is_secret: secret }, other_user: other ? { id: other } : null }) as unknown as RoomListItem;

function setup(opts: { rooms?: RoomListItem[] | null; create?: () => Promise<{ room: { id: string } }>; slug?: string; isSelf?: boolean } = {}) {
  const createDm = jest.fn(opts.create ?? (async () => ({ room: { id: 'new-dm' } })));
  const navigate = jest.fn();
  const refreshRooms = jest.fn(async (_slug: string) => undefined);
  let slug = opts.slug ?? 'acme';
  const deps: DmFlowDeps = {
    createDm: createDm as DmFlowDeps['createDm'],
    cachedRooms: async () => opts.rooms ?? null,
    refreshRooms: refreshRooms as DmFlowDeps['refreshRooms'],
    currentSlug: () => slug,
    navigate,
  };
  const seen: DmFlowSnapshot[] = [];
  const flow = new ProfileDmFlow(deps, 'u2', 'acme', opts.isSelf ?? false, s => seen.push(s));
  return { flow, createDm, navigate, refreshRooms, seen, setSlug: (s: string) => { slug = s; } };
}
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('ProfileDmFlow (TC-MOB-PROFPOP-001..)', () => {
  it('001 existing normal DM navigates with no POST', async () => {
    const t = setup({ rooms: [item('r-dm', 'dm', 'u2')] });
    await t.flow.start();
    expect(t.navigate).toHaveBeenCalledWith('r-dm');
    expect(t.createDm).not.toHaveBeenCalled();
  });

  it('002 a secret DM is never reused: POST then navigate and refresh the list', async () => {
    const t = setup({ rooms: [item('r-secret', 'dm', 'u2', true)] });
    await t.flow.start();
    expect(t.createDm).toHaveBeenCalledTimes(1);
    expect(t.refreshRooms).toHaveBeenCalledWith('acme');
    expect(t.navigate).toHaveBeenCalledWith('new-dm');
  });

  it('003 no cached list (offline cache miss) still POSTs', async () => {
    const t = setup({ rooms: null });
    await t.flow.start();
    expect(t.createDm).toHaveBeenCalledTimes(1);
    expect(t.navigate).toHaveBeenCalledWith('new-dm');
  });

  it('004 double tap sends exactly one POST', async () => {
    const d = deferred<{ room: { id: string } }>();
    const t = setup({ create: () => d.promise });
    const first = t.flow.start();
    const second = t.flow.start();
    await Promise.resolve();
    d.resolve({ room: { id: 'new-dm' } });
    await Promise.all([first, second]);
    expect(t.createDm).toHaveBeenCalledTimes(1);
    expect(t.navigate).toHaveBeenCalledTimes(1);
  });

  it('005 dispose while in flight: no navigate, no further state', async () => {
    const d = deferred<{ room: { id: string } }>();
    const t = setup({ create: () => d.promise });
    const run = t.flow.start();
    await new Promise(r => setTimeout(r, 0));
    const before = t.seen.length;
    t.flow.dispose();
    d.resolve({ room: { id: 'new-dm' } });
    await run;
    expect(t.navigate).not.toHaveBeenCalled();
    expect(t.refreshRooms).not.toHaveBeenCalled();
    expect(t.seen.length).toBe(before);
  });

  it('006 workspace switched mid-flight drops the result', async () => {
    const d = deferred<{ room: { id: string } }>();
    const t = setup({ create: () => d.promise });
    const run = t.flow.start();
    await new Promise(r => setTimeout(r, 0));
    t.setSlug('globex');
    d.resolve({ room: { id: 'new-dm' } });
    await run;
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 404 }, 'unavailable'],
    [{ status: 403 }, 'forbidden'],
    [{ status: 422, code: 'ROOM_DM_SELF' }, 'self'],
    [new TypeError('Network request failed'), 'network'],
    [{ status: 500 }, 'generic'],
  ])('007 failure %j -> %s, busy cleared', async (error, expected) => {
    const t = setup({ create: async () => { throw error; } });
    await t.flow.start();
    expect(t.flow.snapshot).toEqual({ busy: false, state: expected });
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it('008 404/self hide the button (canStart false); 403 and network allow a retry that works', async () => {
    let attempts = 0;
    const t = setup({ create: async () => { if (attempts++ === 0) throw { status: 403 }; return { room: { id: 'new-dm' } }; } });
    await t.flow.start();
    expect(t.flow.canStart).toBe(true);
    await t.flow.start();
    expect(t.navigate).toHaveBeenCalledWith('new-dm');

    const gone = setup({ create: async () => { throw { status: 404 }; } });
    await gone.flow.start();
    expect(gone.flow.canStart).toBe(false);
    await gone.flow.start();
    expect(gone.createDm).toHaveBeenCalledTimes(1);
  });

  it('009 your own profile: no button, start() is a no-op', async () => {
    const t = setup({ isSelf: true });
    expect(t.flow.canStart).toBe(false);
    await t.flow.start();
    expect(t.createDm).not.toHaveBeenCalled();
  });

  it('010 a failing list refresh does not block navigation', async () => {
    const t = setup();
    t.refreshRooms.mockRejectedValueOnce(new Error('offline') as never);
    await t.flow.start();
    expect(t.navigate).toHaveBeenCalledWith('new-dm');
  });
});

describe('resolveRoomType (TC-MOB-PROFPOP-011)', () => {
  it('uses the cached list, falls back to GET /rooms/{id}, null when both fail', async () => {
    const fetchRoom = jest.fn(async () => ({ room: { type: 'group' } }));
    expect(await resolveRoomType('r1', async () => [item('r1', 'dm', 'u2')], fetchRoom)).toBe('dm');
    expect(fetchRoom).not.toHaveBeenCalled();
    expect(await resolveRoomType('r9', async () => [item('r1', 'dm', 'u2')], fetchRoom)).toBe('group');
    expect(await resolveRoomType('r9', async () => null, async () => { throw new Error('offline'); })).toBeNull();
  });
});
