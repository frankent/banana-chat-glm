import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';

export function WorkspaceSwitcher() {
  const { me, workspaces, currentWorkspace, switchWorkspace } = useSession();
  const query = useQuery({ queryKey: ['workspaces', me?.id], queryFn: () => endpoints.myWorkspaces(), enabled: me !== null });
  useEffect(() => {
    if (query.data) useSession.setState({ workspaces: query.data });
  }, [query.data]);
  if (workspaces.length === 0) {
    return null;
  }

  return (
    <select
      value={currentWorkspace?.workspace.slug ?? ''}
      onChange={(e) => switchWorkspace(e.target.value)}
      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium"
      aria-label="Workspace"
    >
      {(query.data ?? workspaces).map(({ workspace, unread_rooms_count }) => (
        <option key={workspace.id} value={workspace.slug}>
          {workspace.name}
          {unread_rooms_count > 0 ? ` (${unread_rooms_count})` : ''}
        </option>
      ))}
    </select>
  );
}
