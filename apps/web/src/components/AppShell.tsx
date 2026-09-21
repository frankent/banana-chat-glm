import { useEffect, useState, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { WorkspaceInvite } from '@banana-chat/shared';
import { useSession } from '../state/session';
import { useChatText } from '../lib/use-chat-text';
import { ConnectionBanner } from './ConnectionBanner';
import { InviteQrDialog } from './InviteQrDialog';
import { Logo } from './Logo';
import { NotificationCenter } from './NotificationCenter';
import { NotificationPrompt } from './NotificationPrompt';
import { RoomList } from './RoomList';
import { AiConversationList } from './ai/AiConversationList';
import { Avatar, Banana, Icon } from './Visual';
import { PublicChatBadge } from './PublicChatBadge';
import { useEcho } from '../echo/EchoProvider';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * Where the notification bell is mounted, matching chat.css's 767px breakpoint.
 *
 * The bell has to live in the mobile top bar: inside the sidebar it sits behind the
 * hamburger, so on a phone it was three taps from anywhere and effectively invisible
 * -- which is why no phone had ever completed the push opt-in. It is moved rather
 * than duplicated so `data-testid="notification-bell"` stays unique for e2e.
 */
function useIsMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return isMobile;
}

export function AppShell() {
  const { status, me, currentWorkspace, logout } = useSession();
  const { text } = useChatText();
  const location = useLocation();
  const navigate = useNavigate();
  const [accountOpen, setAccountOpen] = useState(false);
  const isMobileLayout = useIsMobileLayout();
  const accountRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  // FR-WS-006/DEC-081 — kept per-workspace so reopening the menu shows the
  // still-live invite instead of minting a new one; naturally cleared on
  // logout (AppShell unmounts) and never shown for a different workspace.
  const [invitesByWorkspace, setInvitesByWorkspace] = useState<Record<string, WorkspaceInvite>>({});
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  // Close on outside click and Escape -- a menu you cannot dismiss is worse than
  // no menu, especially on touch where there is no Escape key.
  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (event: MouseEvent) => {
      if (accountRef.current !== null && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAccountOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [accountOpen]);
  const [sidebarOpen, setSidebarOpen] = useState(location.pathname === '/');
  // Exactly one mount point for the bell, so data-testid="notification-bell" stays
  // unique. On a phone the drawer is absolutely positioned over the top bar, so a
  // bell parked there would be unreachable at '/' where the drawer opens by
  // default -- it follows whichever surface is actually on top.
  // DEC-078 — /ai* shares the chat shell: one side list (RoomList or
  // AiConversationList, never both), the same is-conversation/is-chat-list
  // mobile list<->detail machinery as /rooms/*.
  const roomOpen = location.pathname.startsWith('/rooms/');
  const aiOpen = location.pathname.startsWith('/ai');
  const aiConversationOpen = /^\/ai\/.+/.test(location.pathname);
  const conversationOpen = roomOpen || aiConversationOpen;
  const listOpen = location.pathname === '/' || location.pathname === '/ai' || sidebarOpen;
  const chatSurface = roomOpen || aiOpen || location.pathname === '/';
  const bellInSidebar = !isMobileLayout || listOpen;
  const { connected } = useEcho();
  useEffect(() => { setSidebarOpen(location.pathname === '/' || location.pathname === '/ai'); }, [location.pathname]);

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

  const canInvite = currentWorkspace.role === 'owner' || currentWorkspace.role === 'admin';
  const currentInvite = invitesByWorkspace[currentWorkspace.workspace.id] ?? null;

  return (
    <div className={`bc-app flex h-full flex-col ${chatSurface ? 'bc-chat-shell' : ''} ${conversationOpen ? 'is-conversation' : ''} ${listOpen ? 'is-chat-list' : ''}`}>
      <ConnectionBanner />
      {/* In-flow banner, like ConnectionBanner above it, mounted here so it shows on
          every authenticated route and cannot overlap a control on any of them. */}
      <NotificationPrompt />
      <div className="flex min-h-0 flex-1">
        <nav className="bc-rail" aria-label="Main navigation">
          <button className="bc-brand" aria-label="Home" onClick={() => navigate('/')}><Logo size={32} fallbackSize={30} /></button>
          <div className="bc-rail-links">
            <button className={!location.pathname.startsWith('/meetings') && !location.pathname.startsWith('/board') && !location.pathname.startsWith('/ai') && !location.pathname.startsWith('/search') && !location.pathname.startsWith('/public-chat') && location.pathname !== '/members' ? 'active' : ''} aria-label="Conversations" title="Conversations" onClick={() => { navigate('/'); setSidebarOpen(true); }}><Icon name="chat" size={23} /></button>
            <button className={location.pathname.startsWith('/search') ? 'active' : ''} onClick={() => navigate('/search')} aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)" data-testid="open-search"><Icon name="search" size={23} /></button>
            <button className={location.pathname === '/members' ? 'active' : ''} onClick={() => navigate('/members')} aria-label="Workspace members" title="Workspace members"><Icon name="users" /></button>
            <button className={location.pathname.startsWith('/meetings') ? 'active' : ''} aria-label="Meetings" title="Meetings" onClick={() => navigate('/meetings')}><Icon name="video" /></button>
            <button className={location.pathname.startsWith('/board') ? 'active' : ''} aria-label="Kanban board" title="Kanban board" onClick={() => navigate('/board')}><Icon name="board" /></button>
            {/* FR-PCHAT-003 — support queue. The badge is API-227 new+problem. */}
            <button className={location.pathname.startsWith('/public-chat') ? 'active' : ''} aria-label="Public Chat" title="Public Chat" onClick={() => navigate('/public-chat')}><Icon name="lifebuoy" /><PublicChatBadge /></button>
            <div className="bc-rail-divider" />
            <button className={location.pathname.startsWith('/ai') ? 'active' : ''} aria-label="AI Assistant" title="AI Assistant" onClick={() => navigate('/ai')}><Icon name="sparkle" size={23} /></button>
          </div>
          {/* Account menu. An unlabeled lock icon in the rail was technically an
              entry point but nobody found it -- customers still reported they
              could not change their password. Clicking your own avatar is the
              convention people already look for, and it gives the actions real
              text labels instead of a tooltip that never appears on touch. */}
          <div className="bc-rail-bottom">
            <button onClick={() => void logout()} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
            <div className="bc-account" ref={accountRef}>
              <button
                ref={accountTriggerRef}
                className="bc-account-trigger"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-label="Account menu"
                onClick={() => setAccountOpen((open) => !open)}
              >
                <Avatar name={me?.display_name ?? ''} />
              </button>
              {accountOpen && (
                <div className="bc-account-menu" role="menu">
                  <div className="bc-account-who">
                    <strong>{me?.display_name}</strong>
                    <span>@{me?.username}</span>
                  </div>
                  <button role="menuitem" onClick={() => { setAccountOpen(false); navigate('/change-password'); }}>
                    <Icon name="lock" size={16} /> Change password
                  </button>
                  {canInvite && (
                    <button role="menuitem" aria-haspopup="dialog" onClick={() => { setAccountOpen(false); setInviteDialogOpen(true); }}>
                      <Icon name="qr" size={16} /> {text('invite.menu')}
                    </button>
                  )}
                  <button role="menuitem" onClick={() => { setAccountOpen(false); void logout(); }}>
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </nav>
        {inviteDialogOpen && (
          <InviteQrDialog
            slug={currentWorkspace.workspace.slug}
            workspaceName={currentWorkspace.workspace.name}
            invite={currentInvite}
            onIssued={invite => setInvitesByWorkspace(prev => ({ ...prev, [currentWorkspace.workspace.id]: invite }))}
            onRevoked={() => setInvitesByWorkspace(prev => { const next = { ...prev }; delete next[currentWorkspace.workspace.id]; return next; })}
            onClose={() => { setInviteDialogOpen(false); accountTriggerRef.current?.focus(); }}
          />
        )}
        {sidebarOpen && <button className="bc-sidebar-shade" aria-label="Close conversations" onClick={() => setSidebarOpen(false)} />}
        <aside className={`bc-sidebar ${sidebarOpen ? 'is-open' : ''}`} onClick={(event) => { if ((event.target as HTMLElement).closest('a[href]')) setSidebarOpen(false); }}>
          <div className="bc-workspace"><span className="bc-workspace-symbol">{currentWorkspace.workspace.name[0]}</span><div><span className="bc-eyebrow">YOUR WORKSPACE</span><WorkspaceSwitcher /></div>{bellInSidebar && <NotificationCenter />}</div>
          {/* FR-UI-CL-005 — the sidebar previously duplicated a "Messages." heading
              and marketing caption here; the workspace switcher above already
              names the space, so this header keeps only search, "new chat" and
              the All/Unread filter (now inside RoomList). */}

          <div className="min-h-0 flex-1">
            {aiOpen
              ? <AiConversationList key={`ai:${me?.id}`} slug={currentWorkspace.workspace.slug} />
              : <RoomList key={`${me?.id}:${currentWorkspace.workspace.id}`} slug={currentWorkspace.workspace.slug} />}
          </div>
          <div className="bc-sidebar-footer"><span className={connected ? 'bc-status-dot connected' : 'bc-status-dot'} />{connected ? 'Connected to your workspace' : 'Reconnecting…'}<span>✳</span></div>
        </aside>
        <main className="bc-main min-w-0 flex-1">
          <div className="bc-mobile-top"><button aria-label="Show conversations" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="menu" /></button><span className="bc-mobile-brand"><Logo size={28} fallbackSize={26} /></span>{!bellInSidebar && <div className="bc-mobile-top-actions"><NotificationCenter /></div>}</div>
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
