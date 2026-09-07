import { create } from 'zustand';
import type { UserStub, WorkspaceSummary } from '@banana-chat/shared';
import { endpoints, tokenManager } from '../lib/api';
import { clearAllCaches } from '../lib/cache';

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
    try {
      await endpoints.logout();
    } catch {
      // already unauthenticated — fall through to local clear
    }
    tokenManager.clear();
    // TC-CORE-021 — wipe rooms/messages/AI cache before the next user logs in
    void clearAllCaches();
    set({ status: 'anonymous', me: null, workspaces: [], currentWorkspace: null });
  },

  switchWorkspace(slug) {
    const next = get().workspaces.find((w) => w.workspace.slug === slug) ?? null;
    window.localStorage.setItem(LAST_WS_KEY, slug);
    set({ currentWorkspace: next });
  },
}));
