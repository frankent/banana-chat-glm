import { create } from 'zustand';
import type { UserStub, WorkspaceSummary } from '@banana-chat/shared';
import { ApiClient, type ApiClient as ApiClientType } from '@banana-chat/api-client';
import { endpoints, tokenManager } from '../lib/api';
import { primeTokenStore, secureTokenStore } from './token-store';
import { openMobileDb, type MobileSqliteDatabase } from '../db/driver';
import { migrateDb } from '../db/schema';
import { SqliteAiCacheAdapter, SqliteCacheAdapter } from '../db/sqlite-cache';
import { Outbox } from '@banana-chat/chat-core';

export interface Me extends UserStub {
  locale: string;
  must_change_password?: boolean;
}

interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  me: Me | null;
  workspaces: WorkspaceSummary[];
  currentWorkspace: WorkspaceSummary | null;
  db: MobileSqliteDatabase | null;
  /** R3 — set when opening/migrating the local db failed; caches/outbox stay non-persistent until this clears. */
  dbError: string | null;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<'ok' | 'must_change_password'>;
  logout: () => Promise<void>;
  switchWorkspace: (slug: string) => void;
}

/**
 * R3 — opens + migrates the local db exactly once. A failure is logged and
 * surfaced through session.dbError (never silently swallowed) and does NOT
 * cache the rejection, so the next caller (e.g. login() following a failed
 * bootstrap) retries instead of being stuck non-persistent for the process
 * lifetime.
 */
let dbPromise: Promise<MobileSqliteDatabase | null> | null = null;

function ensureDb(): Promise<MobileSqliteDatabase | null> {
  if (dbPromise === null) {
    dbPromise = (async () => {
      try {
        const db = await openMobileDb();
        await migrateDb(db);
        useSession.setState({ dbError: null });
        return db;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[session] failed to open local database', e);
        useSession.setState({ dbError: message });
        dbPromise = null;
        return null;
      }
    })();
  }
  return dbPromise;
}

/**
 * TASK-MOB-001/002 — session + caches + outbox singletons. Logout wipes the
 * SQLite caches and SecureStore (TC-MOB-004).
 */
export const useSession = create<SessionState>((set, get) => ({
  status: secureTokenStore.getRefreshToken() === null ? 'anonymous' : 'loading',
  me: null,
  workspaces: [],
  currentWorkspace: null,
  db: null,
  dbError: null,

  async bootstrap() {
    const [, db] = await Promise.all([primeTokenStore(), ensureDb()]);
    if (!tokenManager.isLoggedIn()) {
      set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null, db });
      return;
    }
    try {
      const [meRes, workspaces] = await Promise.all([endpoints.me(), endpoints.myWorkspaces()]);
      set({
        status: 'authenticated',
        me: meRes.user as Me,
        workspaces,
        currentWorkspace: workspaces[0] ?? null,
        db,
      });
    } catch {
      set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null, db });
    }
  },

  async login(username, password) {
    const [res, db] = await Promise.all([
      endpoints.login(username, password, {
        platform: 'ios',
        name: 'Banana Chat mobile',
      }),
      ensureDb(),
    ]);
    tokenManager.setTokens(res.access_token, res.refresh_token);
    set({
      status: 'authenticated',
      me: res.user,
      workspaces: res.workspaces,
      currentWorkspace: res.workspaces[0] ?? null,
      db,
    });
    return res.user.must_change_password ? 'must_change_password' : 'ok';
  },

  async logout() {
    try {
      await endpoints.logout();
    } catch {
      // already unauthenticated — fall through to local clear
    }
    tokenManager.clear();
    const db = get().db;
    if (db !== null) {
      try {
        // TC-MOB-004 — wipe every scope this build ever opened
        await db.execAsync('DELETE FROM cache_messages; DELETE FROM cache_outbox; DELETE FROM cache_rooms; DELETE FROM ai_messages; DELETE FROM ai_conversations; DELETE FROM cache_meta;');
      } catch (e) {
        // R3 — a wipe failure must not leave the user stuck "authenticated"
        // with cleared tokens; surface it and still complete the logout.
        console.error('[session] failed to wipe local caches on logout', e);
      }
    }
    set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null });
  },

  switchWorkspace(slug) {
    // TC-MOB-008 — switching ws only changes the active scope key; the other
    // workspace's cached rows stay in SQLite untouched
    const next = get().workspaces.find((w) => w.workspace.slug === slug) ?? null;
    set({ currentWorkspace: next });
  },
}));

/** room cache for the active (user, workspace) scope; 200 msgs/room */
export function roomCache(): SqliteCacheAdapter | null {
  const { me, currentWorkspace, db } = useSession.getState();
  if (me === null || currentWorkspace === null || db === null) {
    return null;
  }
  return new SqliteCacheAdapter({ db, scope: { userId: me.id, workspaceId: currentWorkspace.workspace.id } });
}

export function aiCache(): SqliteAiCacheAdapter | null {
  const { me, db } = useSession.getState();
  if (me === null || db === null) {
    return null;
  }
  return new SqliteAiCacheAdapter({ db, userId: me.id });
}

/** the outbox persists through the room cache adapter of the active scope */
export function scopedOutbox(): Outbox | null {
  const cache = roomCache();
  return cache === null ? null : new Outbox(cache);
}

export type { ApiClientType };
