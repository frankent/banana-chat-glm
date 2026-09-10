import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../state/session';
import { ConnectionBanner } from './ConnectionBanner';
import { NotificationCenter } from './NotificationCenter';
import { RoomList } from './RoomList';
import { Avatar, Banana, Icon } from './Visual';
import { useEcho } from '../echo/EchoProvider';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

export function AppShell() {
  const { status, me, currentWorkspace, logout } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { connected } = useEcho();
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  // TASK-WEB-018 — Ctrl/Cmd+K jumps to search
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        navigate('/search');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate]);

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
    <div className="bc-app flex h-full flex-col">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
        <nav className="bc-rail" aria-label="Main navigation">
          <button className="bc-brand" aria-label="Banana Chat home" onClick={() => navigate('/')}><Banana /></button>
          <div className="bc-rail-links">
            <button className={!location.pathname.startsWith('/ai') && !location.pathname.startsWith('/search') ? 'active' : ''} aria-label="Conversations" title="Conversations" onClick={() => setSidebarOpen(true)}><Icon name="chat" size={23} /></button>
            <button className={location.pathname.startsWith('/search') ? 'active' : ''} onClick={() => navigate('/search')} aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)" data-testid="open-search"><Icon name="search" size={23} /></button>
            <div className="bc-rail-divider" />
            <button className={location.pathname.startsWith('/ai') ? 'active' : ''} aria-label="AI Assistant" title="AI Assistant" onClick={() => navigate('/ai')}><Icon name="sparkle" size={23} /></button>
          </div>
          <div className="bc-rail-bottom"><button onClick={() => void logout()} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button><Avatar name={me?.display_name ?? ''} /></div>
        </nav>
        {sidebarOpen && <button className="bc-sidebar-shade" aria-label="Close conversations" onClick={() => setSidebarOpen(false)} />}
        <aside className={`bc-sidebar ${sidebarOpen ? 'is-open' : ''}`} onClick={(event) => { if ((event.target as HTMLElement).closest('a[href]')) setSidebarOpen(false); }}>
          <div className="bc-workspace"><span className="bc-workspace-symbol">{currentWorkspace.workspace.name[0]}</span><div><span className="bc-eyebrow">YOUR WORKSPACE</span><WorkspaceSwitcher /></div><NotificationCenter /></div>
          <div className="bc-sidebar-heading"><h1>Messages<span>.</span></h1><span className="bc-caption">Your people, closer</span></div>
          <button className="bc-search" onClick={() => navigate('/search')}><Icon name="search" size={16} /><span>Search conversations</span><kbd>⌘ K</kbd></button>
          <SidebarAiButton />
          <div className="min-h-0 flex-1"><RoomList slug={currentWorkspace.workspace.slug} /></div>
          <div className="bc-sidebar-footer"><span className={connected ? 'bc-status-dot connected' : 'bc-status-dot'} />{connected ? 'Connected to your workspace' : 'Reconnecting…'}<span>✳</span></div>
        </aside>
        <main className="bc-main min-w-0 flex-1">
          <div className="bc-mobile-top"><button aria-label="Show conversations" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="menu" /></button><span>Banana Chat</span></div>
          <div className="bc-outlet"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}

export function WelcomeView() {
  const navigate = useNavigate();
  return <div className="bc-welcome"><div className="bc-welcome-orbit"><div className="bc-welcome-mark"><Banana size={86} /></div><span className="bc-welcome-spark">✦</span><span className="bc-welcome-chat"><Icon name="chat" size={30} /></span></div><span className="bc-eyebrow">YOUR PEOPLE. YOUR SPACE.</span><h2>Good things happen together.</h2><p>Choose a conversation and bring your workspace together.</p><button className="bc-primary" onClick={() => navigate('/search')}>Find a conversation <Icon name="arrow" size={17} /></button><small><Icon name="lock" size={14} /> A private space for your workspace</small></div>;
}

/** FR-AI-001 — AI Assistant entry point, hidden when the feature is off. */
function SidebarAiButton() {
  const navigate = useNavigate();
  const location = useLocation();
  if (location.pathname.startsWith('/ai')) {
    return null; // already there
  }
  return <button className="bc-ai-entry" onClick={() => navigate('/ai')} title="AI Assistant"><span><Icon name="sparkle" size={23} /></span><div><strong>AI Assistant</strong><small>A little help, a lot of possibility</small></div><em>AI</em></button>;
}
