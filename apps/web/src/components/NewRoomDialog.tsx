import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@banana-chat/api-client';
import { SECRET_EXPIRY_MAX_DAYS, SECRET_EXPIRY_MIN_DAYS } from '@banana-chat/chat-core';
import type { UserStub } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useDirectory } from '../hooks/useRooms';

const EXPIRY_CHOICES = Array.from(
  { length: SECRET_EXPIRY_MAX_DAYS - SECRET_EXPIRY_MIN_DAYS + 1 },
  (_, i) => SECRET_EXPIRY_MIN_DAYS + i,
);

export function NewRoomDialog({ slug }: { slug: string }) {
  const [open, setOpen] = useState<'dm' | 'group' | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [secret, setSecret] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: people } = useDirectory(slug, query);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const createDm = useMutation({
    mutationFn: (userId: string) => endpoints.createDm(userId, slug, secret ? { secret: true, expiryDays } : undefined),
    onSuccess: (detail) => {
      invalidate();
      setOpen(null);
      navigate(`/rooms/${detail.room.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed to create DM'),
  });

  const createGroup = useMutation({
    mutationFn: () => endpoints.createGroup(groupName.trim(), [...selected], slug, undefined, secret ? { secret: true, expiryDays } : undefined),
    onSuccess: (detail) => {
      invalidate();
      setOpen(null);
      setGroupName('');
      setSelected(new Set());
      navigate(`/rooms/${detail.room.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Failed to create group'),
  });

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  if (open === null) {
    return (
      <div className="flex gap-2">
        <button onClick={() => { setOpen('dm'); setError(null); }} className="flex-1 rounded-lg bg-slate-800 py-2 text-sm font-medium text-white hover:bg-slate-700">
          + DM
        </button>
        <button onClick={() => { setOpen('group'); setError(null); }} className="flex-1 rounded-lg bg-slate-800 py-2 text-sm font-medium text-white hover:bg-slate-700">
          + Group
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{open === 'dm' ? 'New direct message' : 'New group'}</h3>
        <button onClick={() => setOpen(null)} className="text-sm text-slate-400 hover:text-slate-600">✕</button>
      </div>
      {error !== null && <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>}
      {open === 'group' && (
        <input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          placeholder="Group name"
          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people…"
        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        autoFocus
      />
      <ul className="max-h-48 space-y-0.5 overflow-y-auto">
        {people?.map((user: UserStub) => (
          <li key={user.id}>
            <button
              onClick={() => {
                if (open === 'dm') {
                  createDm.mutate(user.id);
                } else {
                  toggle(user.id);
                }
              }}
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-white ${selected.has(user.id) ? 'bg-yellow-100' : ''}`}
            >
              <span>{user.display_name} <span className="text-xs text-slate-400">@{user.username}</span></span>
              {open === 'group' && <span>{selected.has(user.id) ? '✓' : '+'}</span>}
            </button>
          </li>
        ))}
      </ul>

      {/* FR-ROOM-012 — secret opt-in with explicit expiry + honest disclosure */}
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <label className="flex items-center gap-2 text-sm font-medium" data-testid="secret-toggle">
          <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
          🔒 Secret room (auto-deletes)
        </label>
        {secret && (
          <div className="mt-2 space-y-2" data-testid="secret-options">
            <label className="flex items-center gap-2 text-sm">
              Delete after
              <select
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
                className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                data-testid="secret-expiry"
              >
                {EXPIRY_CHOICES.map((d) => (
                  <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>
                ))}
              </select>
            </label>
            <p className="text-xs leading-relaxed text-slate-500" data-testid="secret-explain">
              Messages, files, notes and calls are deleted from the server when the room expires
              ({SECRET_EXPIRY_MIN_DAYS}–{SECRET_EXPIRY_MAX_DAYS} days from creation). Secret means expiring — it is
              not end-to-end encrypted, and messages may still exist in normal server backups until those rotate.
            </p>
          </div>
        )}
      </div>

      {open === 'group' && (
        <button
          onClick={() => createGroup.mutate()}
          disabled={groupName.trim() === '' || selected.size === 0 || createGroup.isPending}
          className="w-full rounded-lg bg-yellow-400 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Create group ({selected.size} members)
        </button>
      )}
      {open === 'dm' && secret && (
        <p className="text-xs text-slate-400">
          This creates a separate secret conversation — your ordinary DM with this person stays untouched.
        </p>
      )}
    </div>
  );
}
