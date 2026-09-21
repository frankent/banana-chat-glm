import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReadStatusEntry } from '@banana-chat/shared';
import { Avatar, Icon } from './Visual';

/**
 * FR-READ-002 — DM shows plain "Seen"; group shows a tappable "Read by N".
 * Stateless: the parent owns which reader list (if any) is open, so sending
 * a new own message — which changes which message is "latest" and therefore
 * unmounts this trigger — can't also unmount an already-open reader dialog.
 */
export function ReadReceiptTrigger({
  roomType,
  others,
  text,
  onOpen,
}: {
  roomType: 'dm' | 'group';
  others: ReadStatusEntry[];
  text: (key: string) => string;
  onOpen: (entries: ReadStatusEntry[]) => void;
}) {
  if (others.length === 0) {
    return null;
  }

  if (roomType === 'dm') {
    return (
      <div className="flex justify-end pr-1">
        <span className="text-xs font-medium" style={{ color: 'var(--chat-muted)' }} data-testid="seen-indicator">{text('chat.seen')}</span>
      </div>
    );
  }

  return (
    <div className="bc-read-receipt">
      <button type="button" data-testid="read-receipt-button" onClick={() => onOpen(others)}>
        {text('chat.readByCount').replace('{count}', String(others.length))}
      </button>
    </div>
  );
}

/** Owned by the room, not by any one message — see ReadReceiptTrigger above. */
export function ReadReceiptDialog({
  entries,
  onClose,
  text,
}: {
  entries: ReadStatusEntry[];
  onClose: () => void;
  text: (key: string) => string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const label = text('chat.readByCount').replace('{count}', String(entries.length));

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bc-message-menu bc-read-list"
      data-testid="read-receipt-list"
      aria-label={label}
      onCancel={onClose}
      onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }}
    >
      <div className="bc-message-menu-heading">
        <strong>{label}</strong>
        <button autoFocus className="bc-chat-control" aria-label={text('chat.cancel')} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <ul className="bc-read-list-items">
        {entries.map((entry) => (
          <li key={entry.user_id} className="bc-read-list-row">
            <Avatar name={entry.display_name} />
            <span>{entry.display_name}</span>
          </li>
        ))}
      </ul>
    </dialog>,
    document.body,
  );
}
