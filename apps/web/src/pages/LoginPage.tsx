import { meetingReturnPath } from '@banana-chat/chat-core';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@banana-chat/api-client';
import { useSession } from '../state/session';

import { Banana, Icon, Avatar } from '../components/Visual';

export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(username.trim(), password);
      navigate(result === 'must_change_password' ? '/change-password' : (meetingReturnPath(params.get('returnTo')) ?? '/'), { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bc-login">
      <section className="bc-login-story">
        <div className="bc-wordmark"><span className="bc-brand"><Banana /></span>banana<span>chat</span></div>
        <div className="bc-story-content"><span className="bc-eyebrow">A LITTLE CLOSER, EVERY DAY</span><h1>Great work starts<br />with a <span>hello.</span></h1><p>A place for your people, your ideas,<br />and everything you’ll create together.</p><div className="bc-story-message"><Avatar name="Your workspace" /><div><strong>Your workspace</strong><p>Good things happen together.</p></div></div><div className="bc-story-message second"><span>Let’s make something great ✨</span></div></div>
        <footer>YOUR PEOPLE. YOUR SPACE. <span>✳</span> BANANA CHAT</footer>
        <div className="bc-story-decoration"><Banana size={380} /></div>
      </section>
      <section className="bc-login-form-section">
      <form onSubmit={onSubmit} className="bc-login-form space-y-4">
        <div className="bc-login-symbol"><Icon name="chat" size={36} /><span>✦</span></div>
        <span className="bc-eyebrow">WELCOME TO BANANA CHAT</span>
        <h2>Good to see you<span>.</span></h2><p className="bc-login-intro">Sign in to your workspace.<br />Your conversations are waiting for you.</p>
        {error !== null && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <label className="block text-sm font-medium text-slate-700">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy || username === '' || password === ''}
          className="w-full rounded-lg bg-yellow-400 py-2 text-sm font-semibold text-slate-900 hover:bg-yellow-300 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="bc-login-help">Need an account? Contact your workspace administrator.</p>
        <div className="bc-login-secure"><Icon name="lock" size={14} /> A private space for your workspace</div>
      </form><footer>Thoughtfully connected. <span>Banana Chat</span></footer>
      </section>
    </div>
  );
}
