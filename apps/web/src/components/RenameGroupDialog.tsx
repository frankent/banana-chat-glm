import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, NetworkError } from '@banana-chat/api-client';
import { endpoints } from '../lib/api';
import { renameText, type RenameTextKey } from '../lib/rename-text';
import { useChatText } from '../lib/use-chat-text';
import { useSession } from '../state/session';
import { Icon } from './Visual';
import '../avatar.css';

const MAX = 100;

function errorKey(error: unknown): RenameTextKey {
  if (error instanceof ApiError && (error.code === 'ROOM_FORBIDDEN' || error.status === 403)) return 'errForbidden';
  if (error instanceof NetworkError || error instanceof TypeError) return 'errNetwork';
  return 'errGeneric';
}

/** FR-ROOM-007 / DEC-092 — any member renames the group (PATCH /rooms/{id} {name}); the server gate is who_can_edit_info. */
export function RenameGroupDialog({ roomId, currentName, onClose }: { roomId: string; currentName: string; onClose: () => void }) {
  const { locale } = useChatText();
  const text = renameText[locale];
  const slug = useSession(s => s.currentWorkspace?.workspace.slug ?? '');
  const queryClient = useQueryClient();
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RenameTextKey | null>(null);
  const trimmed = value.trim();
  const unchanged = trimmed === currentName.trim();

  useEffect(() => { dialogRef.current?.showModal(); inputRef.current?.select(); }, []);

  const close = () => { dialogRef.current?.close(); onClose(); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || slug === '' || trimmed === '' || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.updateRoom(roomId, slug, { name: trimmed });
      for (const key of ['rooms', 'room']) void queryClient.invalidateQueries({ queryKey: [key] });
      close();
    } catch (caught) {
      setBusy(false);
      setError(errorKey(caught));
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bc-avatar-editor bc-rename"
      data-testid="rename-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      lang={locale}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    >
      <header className="bc-ae-header">
        <div>
          <h2 id={titleId}>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button type="button" className="bc-ae-icon-button" aria-label={text.close} onClick={close} disabled={busy}><Icon name="close" size={18} /></button>
      </header>
      <form className="bc-rename-form" onSubmit={event => void submit(event)} noValidate>
        <label htmlFor={inputId}>{text.label}</label>
        <input
          ref={inputRef}
          id={inputId}
          className="bc-rename-input"
          data-testid="rename-input"
          value={value}
          maxLength={MAX}
          autoComplete="off"
          disabled={busy}
          aria-describedby={error !== null ? `${inputId}-error` : undefined}
          onChange={event => setValue(event.target.value)}
        />
        <span className="bc-rename-counter" aria-hidden="true">{text.counter.replace('{n}', String(value.length))}</span>
        {error !== null && <p className="bc-ae-error" id={`${inputId}-error`} role="alert" data-testid="rename-error">{text[error]}</p>}
        <footer className="bc-ae-actions">
          <button type="button" className="bc-ae-button is-secondary" onClick={close} disabled={busy}>{text.cancel}</button>
          <button type="submit" className="bc-ae-button is-primary" disabled={busy || trimmed === '' || unchanged} data-testid="rename-save">{busy ? text.saving : text.save}</button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
