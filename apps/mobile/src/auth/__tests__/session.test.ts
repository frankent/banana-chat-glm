import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Outbox } from '@banana-chat/chat-core';
import { openTestDb, type BetterSqliteDb } from '../../db/__tests__/better-sqlite-driver';

/**
 * R3 (REVIEW.md 2026-09-19) — mobile persistence was never initialized:
 * session.db stayed null forever, so roomCache()/scopedOutbox() always fell
 * back to a nonpersistent queue. These tests exercise the real bootstrap ->
 * enqueue -> "restart" -> restore -> logout path against a real (in-memory)
 * SQLite db, and the failure-surfacing path when opening it throws.
 */

let dbs: BetterSqliteDb[] = [];

function fakeUser() {
  return { id: 'user-1', username: 'tony', display_name: 'Tony', locale: 'th', status: 'active' };
}

function fakeWorkspace() {
  return { workspace: { id: 'ws-1', slug: 'acme', name: 'Acme' }, total_unread: 0 } as never;
}

/** jest.resetModules() + a fresh require() per test — session.ts holds
 * module-level singletons (the zustand store, the cached db-open promise)
 * that must not leak between test cases. */
function loadSessionModule(opts: {
  dbFactory: () => Promise<BetterSqliteDb>;
  isLoggedIn: boolean;
}) {
  jest.resetModules();

  jest.doMock('../../lib/api', () => ({
    endpoints: {
      me: jest.fn(async () => ({ user: fakeUser() })),
      myWorkspaces: jest.fn(async () => [fakeWorkspace()]),
      login: jest.fn(async () => ({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        user: { ...fakeUser(), must_change_password: false },
        workspaces: [fakeWorkspace()],
      })),
      logout: jest.fn(async () => undefined),
    },
    tokenManager: {
      isLoggedIn: jest.fn(() => opts.isLoggedIn),
      setTokens: jest.fn(),
      clear: jest.fn(),
    },
  }));

  jest.doMock('../token-store', () => ({
    primeTokenStore: jest.fn(async () => undefined),
    secureTokenStore: {
      getRefreshToken: jest.fn(() => (opts.isLoggedIn ? 'existing-refresh-token' : null)),
      setRefreshToken: jest.fn(),
    },
  }));

  jest.doMock('../../db/driver', () => ({
    openMobileDb: jest.fn(async () => {
      const db = await opts.dbFactory();
      dbs.push(db);
      return db;
    }),
  }));

  return require('../session') as typeof import('../session');
}

beforeEach(() => {
  dbs = [];
});

afterEach(() => {
  for (const db of dbs) db.close();
  jest.resetModules();
});

describe('session db wiring', () => {
  it('bootstrap opens + migrates the local db so caches/outbox survive a restart', async () => {
    const { useSession, roomCache, scopedOutbox } = loadSessionModule({
      dbFactory: async () => openTestDb(),
      isLoggedIn: true,
    });

    await useSession.getState().bootstrap();

    expect(useSession.getState().status).toBe('authenticated');
    expect(useSession.getState().db).not.toBeNull();
    expect(useSession.getState().dbError).toBeNull();
    expect(roomCache()).not.toBeNull();

    // enqueue offline, then simulate an app restart: a NEW Outbox instance
    // over the same persisted db must still see the queued entry.
    const first = scopedOutbox();
    expect(first).not.toBeNull();
    await first!.enqueue({ roomId: 'room-1', workspaceId: 'ws-1', body: 'queued while offline', clientMessageId: 'cmid-1' });

    const revived = new Outbox(roomCache()!);
    await revived.restore();
    expect(revived.all().map((e) => e.client_message_id)).toEqual(['cmid-1']);

    // TC-MOB-004 — logout wipes the outbox scope; must not throw "no such
    // table" (it would have, pre-fix: db was always null so this DELETE was
    // dead code that never ran against a real, migrated schema).
    const dbHandle = useSession.getState().db!;
    await expect(useSession.getState().logout()).resolves.toBeUndefined();
    expect(useSession.getState().status).toBe('anonymous');
    const remaining = await dbHandle.getAllAsync('SELECT * FROM cache_outbox');
    expect(remaining).toHaveLength(0);
  });

  it('a db-open failure surfaces via dbError instead of silently degrading, and does not block auth', async () => {
    const { useSession } = loadSessionModule({
      dbFactory: async () => {
        throw new Error('disk full');
      },
      isLoggedIn: true,
    });

    await useSession.getState().bootstrap();

    expect(useSession.getState().status).toBe('authenticated');
    expect(useSession.getState().db).toBeNull();
    expect(useSession.getState().dbError).toBe('disk full');
  });

  it('login() retries opening the db after a failed bootstrap attempt', async () => {
    let attempt = 0;
    const { useSession, roomCache } = loadSessionModule({
      dbFactory: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('cold start race');
        return openTestDb();
      },
      isLoggedIn: false,
    });

    await useSession.getState().bootstrap();
    expect(useSession.getState().db).toBeNull();
    expect(useSession.getState().dbError).not.toBeNull();

    await useSession.getState().login('tony', 'Password123!');
    expect(useSession.getState().db).not.toBeNull();
    expect(roomCache()).not.toBeNull();
    expect(attempt).toBe(2);
  });
});
