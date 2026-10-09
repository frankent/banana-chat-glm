import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@banana-chat/api-client';
import { ticketLinkUrl } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';
import { useChatText } from '../lib/use-chat-text';
import { useRooms } from '../hooks/useRooms';
import { roomTitle } from './RoomList';
import { Avatar, Icon } from './Visual';
import '../styles/share-ticket.css';

const NOTE_MAX = 500;

/** Maps a failed send to an i18n key (B5.9 error mappings). */
export function shareErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'WS_ARCHIVED') return 'board.shareErrorArchived';
    if (error.code === 'ROOM_EXPIRED' || error.status === 410) return 'board.shareErrorExpired';
    if (error.code === 'ROOM_NOT_MEMBER' || error.status === 403) return 'board.shareErrorMember';
    if (error.status === 429) return 'board.shareErrorRate';
  }
  return 'board.shareError';
}

/** FR-KAN-007: a share is an ordinary new message (not a forward) whose body is `[note\n]<ticket URL>`. */
export function ShareTicketDialog({ slug, ticketId, ticketLabel, archived, returnFocus, onClose, onDone }: {
  slug: string; ticketId: string; ticketLabel: string; archived: boolean;
  returnFocus: HTMLElement | null; onClose: () => void; onDone: (roomName: string) => void;
}) {
  const { text } = useChatText();
  const rooms = useRooms(slug);
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  // One intent per dialog open; retries (same room + same body) reuse it so the server dedupes.
  const [clientMessageId] = useState(() => crypto.randomUUID());
  const sent = useRef<{ roomId: string; body: string } | null>(null);
  const [search, setSearch] = useState('');
  const [roomId, setRoomId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');

  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    searchRef.current?.focus();
    return () => { mounted.current = false; dialog?.close(); returnFocus?.focus({ preventScroll: true }); };
  }, [returnFocus]);

  const needle = search.trim().toLocaleLowerCase();
  const shown = rooms.data?.filter(item => roomTitle(item).toLocaleLowerCase().includes(needle)) ?? [];
  const url = ticketLinkUrl(window.location.origin, ticketId, slug);
  const trimmed = note.trim();
  const body = trimmed === '' ? url : `${trimmed}\n${url}`;

  const send = async () => {
    if (submitting.current || archived || roomId === '') return;
    submitting.current = true;
    setBusy(true);
    setErrorKey('');
    // A changed room/body is a new intent: never reuse an id for different content.
    const id = sent.current !== null && (sent.current.roomId !== roomId || sent.current.body !== body) ? crypto.randomUUID() : clientMessageId;
    sent.current = { roomId, body };
    try {
      await endpoints.sendMessage(roomId, slug, body, id);
      void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      void queryClient.invalidateQueries({ queryKey: ['messages', roomId] });
      const item = rooms.data?.find(r => r.room.id === roomId);
      if (!mounted.current) return;
      onDone(item ? roomTitle(item) : '');
      onClose();
    } catch (error) {
      if (mounted.current) setErrorKey(shareErrorKey(error));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return createPortal(
    <dialog ref={dialogRef} className="bc-share-dialog" data-testid="share-ticket-dialog" aria-labelledby="share-ticket-title" onCancel={onClose}>
      <div className="bc-share-head">
        <strong id="share-ticket-title">{text('board.shareTitle')}</strong>
        <button type="button" className="bc-chat-control" aria-label={text('chat.cancel')} data-testid="share-ticket-close" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      <p className="bc-share-ticket">{ticketLabel}</p>
      {archived && <p className="bc-share-hint bc-share-error" role="alert" data-testid="share-ticket-archived">{text('board.shareArchived')}</p>}
      <label className="bc-share-search"><input ref={searchRef} type="search" data-testid="share-ticket-search" aria-label={text('board.shareSearch')} placeholder={text('board.shareSearch')} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {rooms.isLoading && <p className="bc-share-hint" role="status">{text('chat.loading')}</p>}
      {rooms.isError && <div className="bc-share-hint"><p role="alert">{text('board.shareError')}</p><button type="button" onClick={() => void rooms.refetch()}>{text('chat.retry')}</button></div>}
      <div className="bc-share-rooms" role="radiogroup" aria-label={text('board.shareTitle')} data-testid="share-ticket-rooms">
        {shown.map(item => (
          <label className="bc-share-room" key={item.room.id} data-testid="share-ticket-room" data-room-id={item.room.id}>
            <input type="radio" name="share-ticket-room" checked={roomId === item.room.id} disabled={busy || archived} onChange={() => setRoomId(item.room.id)} />
            <Avatar name={roomTitle(item)} avatar={item.room.type === 'dm' ? item.other_user?.avatar : item.room.avatar} />
            <span className="bc-share-room-name">{item.room.is_secret && <span aria-label={text('room.secret.label')}>🔒 </span>}{roomTitle(item)}</span>
          </label>
        ))}
        {!rooms.isLoading && !rooms.isError && shown.length === 0 && <p className="bc-share-hint">{text('board.shareNoRooms')}</p>}
      </div>
      <label className="bc-share-note">{text('board.shareNote')}
        <textarea data-testid="share-ticket-note" maxLength={NOTE_MAX} value={note} disabled={busy || archived} onChange={event => setNote(event.target.value)} />
      </label>
      {errorKey && <p className="bc-share-hint bc-share-error" role="alert" data-testid="share-ticket-error">{text(errorKey)}</p>}
      <button type="button" className="bc-share-submit" data-testid="share-ticket-send" disabled={busy || archived || roomId === ''} onClick={() => void send()}>{busy ? text('chat.sending') : text('board.shareSend')}</button>
    </dialog>, document.body,
  );
}
