import { create } from 'zustand';
import type { UserStub, WorkspaceSummary } from '@banana-chat/shared';
import { endpoints, tokenManager } from '../lib/api';
import { clearAllCaches } from '../lib/cache';
import { resetSessionResources } from '../lib/session-resources';

export interface Me extends UserStub {
  locale: string;
  must_change_password?: boolean;
}

interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated';
  me: Me | null;
  workspaces: WorkspaceSummary[];
  currentWorkspace: WorkspaceSummary | null;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<'ok' | 'must_change_password'>;
  logout: () => Promise<void>;
  switchWorkspace: (slug: string) => void;
}

const LAST_WS_KEY = 'orgchat.lastWorkspace';

export const useSession = create<SessionState>((set, get) => ({
  status: tokenManager.isLoggedIn() ? 'loading' : 'anonymous',
  me: null,
  workspaces: [],
  currentWorkspace: null,

  async bootstrap() {
    if (!tokenManager.isLoggedIn()) {
      set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null });
      return;
    }
    try {
      const [meRes, workspaces] = await Promise.all([endpoints.me(), endpoints.myWorkspaces()]);
      const me = meRes.user as Me;
      const lastSlug = window.localStorage.getItem(LAST_WS_KEY);
      const current = workspaces.find((w) => w.workspace.slug === lastSlug) ?? workspaces[0] ?? null;
      set({ status: 'authenticated', me, workspaces, currentWorkspace: current });
    } catch {
      set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null });
    }
  },

  async login(username, password) {
    tokenManager.clear();
    await resetSessionResources();
    const res = await endpoints.login(username, password, {
      platform: 'web',
      name: `Browser (${navigator.userAgent.slice(0, 40)})`,
    });
    tokenManager.setTokens(res.access_token, res.refresh_token);
    set({
      status: 'authenticated',
      me: res.user,
      workspaces: res.workspaces,
      currentWorkspace: res.workspaces[0] ?? null,
    });
    return res.user.must_change_password ? 'must_change_password' : 'ok';
  },

  async logout() {
    const revoke = endpoints.logout().catch(() => undefined);
    tokenManager.clear();
    set({ status: 'loading', me: null, workspaces: [], currentWorkspace: null });
    await resetSessionResources();
    await clearAllCaches();
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith('orgchat.draft.')) window.sessionStorage.removeItem(key);
    }
    set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null });
    void revoke;
  },

  switchWorkspace(slug) {
    const next = get().workspaces.find((w) => w.workspace.slug === slug) ?? null;
    window.localStorage.setItem(LAST_WS_KEY, slug);
    set({ currentWorkspace: next });
  },
}));
