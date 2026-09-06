import { useSession } from '../state/session';

export function NoWorkspacePage() {
  const { me, logout } = useSession();
  return (
    <div className="flex min-h-full items-center justify-center">
      <div className="w-80 space-y-4 rounded-2xl bg-white p-8 text-center shadow-lg">
        <h1 className="text-xl font-bold">No workspace yet</h1>
        <p className="text-sm text-slate-500">
          Hi {me?.display_name ?? 'there'} — you haven't been added to any workspace. Ask an admin to assign you one.
        </p>
        <button onClick={() => void logout()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
          Sign out
        </button>
      </div>
    </div>
  );
}
