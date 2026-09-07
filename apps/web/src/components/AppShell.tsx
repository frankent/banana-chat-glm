import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { ConnectionBanner } from './ConnectionBanner';
import { RoomList } from './RoomList';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export function AppShell() {
  const { status, me, currentWorkspace, logout } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return <div className="flex min-h-full items-center justify-center text-sm text-slate-400">Loading…</div>;
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (me !== null && me.must_change_password === true) {
    return <Navigate to="/change-password" replace />;
  }
  if (currentWorkspace === null) {
    return <Navigate to="/no-workspace" replace />;
  }

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="space-y-2 border-b border-slate-100 p-3">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold">🍌 Banana Chat</span>
              <button onClick={() => void logout()} className="text-xs text-slate-400 hover:text-slate-600" title="Sign out">
                ⎋
              </button>
            </div>
            <WorkspaceSwitcher />
          </div>
          <SidebarAiButton />
          <div className="min-h-0 flex-1">
            <RoomList slug={currentWorkspace.workspace.slug} />
          </div>
        </aside>
        <main className="min-w-0 flex-1 bg-slate-100">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** FR-AI-001 — AI Assistant entry point, hidden when the feature is off. */
function SidebarAiButton() {
  const navigate = useNavigate();
  const location = useLocation();
  if (location.pathname.startsWith('/ai')) {
    return null; // already there
  }
  return (
    <div className="border-b border-slate-100 p-2">
      <button
        onClick={() => navigate('/ai')}
        className="w-full rounded-lg bg-gradient-to-r from-amber-100 to-amber-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:from-amber-200"
        title="AI Assistant"
      >
        ✨ AI Assistant
      </button>
    </div>
  );
}
