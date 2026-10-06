import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError } from '@banana-chat/api-client';
import { endpoints } from '../lib/api';
import { addMembersText, type AddMembersTextKey } from '../lib/add-members-text';
import { useChatText } from '../lib/use-chat-text';
import { useSession } from '../state/session';
import { Avatar, Icon } from './Visual';
import '../avatar.css';

const MAX_PICK = 100;

function errorKey(error: unknown): AddMembersTextKey {
  if (error instanceof ApiError && error.code === 'ROOM_FULL') return 'errFull';
  if (error instanceof ApiError && (error.code === 'ROOM_FORBIDDEN' || error.status === 403)) return 'errForbidden';
  if (error instanceof NetworkError || error instanceof TypeError) return 'errNetwork';
  return 'errGeneric';
}

/**
 * FR-ROOM-004 / DEC-096 — add workspace members to a group (POST /rooms/{id}/members, API-023).
 * The directory is queried with room_id so people already inside come back flagged `in_room`.
 */
export function AddMembersDialog({ roomId, onClose, onDone }: { roomId: string; onClose: () => void; onDone: (count: number) => void }) {
  const { locale } = useChatText();
  const text = addMembersText[locale];
  const slug = useSession(s => s.currentWorkspace?.workspace.slug ?? '');
  const queryClient = useQueryClient();
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddMembersTextKey | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    if (window.matchMedia('(max-width: 520px), (max-height: 520px)').matches) dialog.focus();
    else inputRef.current?.focus();
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => setQ(value.trim()), 250); return () => window.clearTimeout(timer); }, [value]);

  const list = useInfiniteQuery({
    queryKey: ['directory-picker', slug, roomId, q],
    initialPageParam: '',
    queryFn: ({ pageParam }) => endpoints.directoryPage(slug, q, pageParam, roomId),
    getNextPageParam: last => last.next_cursor ?? undefined,
    enabled: slug !== '',
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap(page => page.members) ?? [];
  const atLimit = picked.size >= MAX_PICK;

  const close = () => { dialogRef.current?.close(); onClose(); };

  const toggle = (id: string, name: string) => {
    setError(null);
    setPicked(current => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id); else if (next.size < MAX_PICK) next.set(id, name);
      return next;
    });
  };

  const submit = async () => {
    if (busy || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.addRoomMembers(roomId, slug, [...picked.keys()]);
      for (const key of ['rooms', 'room', 'room-members', 'directory-picker']) void queryClient.invalidateQueries({ queryKey: [key] });
      onDone(result.added);
      close();
    } catch (caught) {
      setBusy(false);
      setError(errorKey(caught));
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bc-avatar-editor bc-addmembers"
      data-testid="add-members-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      lang={locale}
      tabIndex={-1}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    >
      <header className="bc-ae-header">
        <div>
          <h2 id={titleId}>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button type="button" className="bc-ae-icon-button" aria-label={text.close} onClick={close} disabled={busy}><Icon name="close" size={18} /></button>
      </header>
      <div className="bc-addmembers-search">
        <label htmlFor={inputId}>{text.label}</label>
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          className="bc-rename-input"
          data-testid="add-members-search"
          value={value}
          maxLength={100}
          placeholder={text.placeholder}
          autoComplete="off"
          disabled={busy}
          onChange={event => setValue(event.target.value)}
        />
      </div>
      <div className="bc-addmembers-list" data-testid="add-members-list" aria-live="polite">
        {list.isPending && <p className="bc-addmembers-note">{text.loading}</p>}
        {list.isError && (
          <p className="bc-ae-error" role="alert" data-testid="add-members-load-error">
            {text.errLoad} <button type="button" className="bc-addmembers-link" onClick={() => void list.refetch()}>{text.retry}</button>
          </p>
        )}
        {list.isSuccess && rows.length === 0 && <p className="bc-addmembers-note" data-testid="add-members-empty">{q === '' ? text.emptyAll : text.empty.replace('{q}', q)}</p>}
        {rows.length > 0 && (
          <ul>
            {rows.map(row => {
              const inRoom = row.in_room === true;
              const checked = picked.has(row.id);
              return (
                <li key={row.id}>
                  <label className={`bc-addmembers-row${inRoom ? ' is-in' : ''}`} data-testid={`add-members-row-${row.username}`}>
                    <input
                      type="checkbox"
                      checked={inRoom || checked}
                      disabled={busy || inRoom || (!checked && atLimit)}
                      onChange={() => toggle(row.id, row.display_name)}
                    />
                    <Avatar name={row.display_name} avatar={row.avatar} />
                    <span className="bc-addmembers-name"><strong>{row.display_name}</strong><small>@{row.username}</small></span>
                    {inRoom && <span className="bc-addmembers-badge">{text.inGroup}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {list.hasNextPage && (
          <button type="button" className="bc-ae-button is-secondary" data-testid="add-members-more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? text.loading : text.loadMore}
          </button>
        )}
      </div>
      {atLimit && <p className="bc-addmembers-note" data-testid="add-members-limit">{text.limit}</p>}
      {error !== null && <p className="bc-ae-error" role="alert" data-testid="add-members-error">{text[error]}</p>}
      <footer className="bc-ae-actions">
        {picked.size > 0 && (
          <span className="bc-addmembers-count" data-testid="add-members-count">
            <span>{text.selected.replace('{n}', String(picked.size))}</span>
            <button type="button" className="bc-addmembers-link" disabled={busy} onClick={() => setPicked(new Map())}>{text.clear}</button>
          </span>
        )}
        <button type="button" className="bc-ae-button is-secondary" onClick={close} disabled={busy}>{text.cancel}</button>
        <button type="button" className="bc-ae-button is-primary" disabled={busy || picked.size === 0} data-testid="add-members-submit" onClick={() => void submit()}>
          {busy ? text.adding : picked.size > 0 ? text.add.replace('{n}', String(picked.size)) : text.addNone}
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
