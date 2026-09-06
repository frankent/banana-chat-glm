import { useSession } from '../state/session';

export function WorkspaceSwitcher() {
  const { workspaces, currentWorkspace, switchWorkspace } = useSession();
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
      {workspaces.map(({ workspace, total_unread }) => (
        <option key={workspace.id} value={workspace.slug}>
          {workspace.name}
          {total_unread > 0 ? ` (${total_unread})` : ''}
        </option>
      ))}
    </select>
  );
}
