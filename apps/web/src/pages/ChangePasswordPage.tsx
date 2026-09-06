import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@banana-chat/api-client';
import { DEFAULT_SETTINGS } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';

export function ChangePasswordPage() {
  const { logout, bootstrap } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const min = DEFAULT_SETTINGS['auth.password.min_length'];

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.changePassword(current, next);
      await bootstrap(); // refresh must_change_password flag
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Password change failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center">
      <form onSubmit={onSubmit} className="w-96 space-y-4 rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="text-xl font-bold">Set a new password</h1>
        <p className="text-sm text-slate-500">Your account requires a password change before continuing.</p>
        {error !== null && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <label className="block text-sm font-medium text-slate-700">
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          New password (min {min} characters)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="flex-1 rounded-lg bg-yellow-400 py-2 text-sm font-semibold hover:bg-yellow-300 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => void logout().then(() => navigate('/login', { replace: true }))} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
            Sign out
          </button>
        </div>
      </form>
    </div>
  );
}
