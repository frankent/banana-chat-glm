import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@banana-chat/api-client';
import type { Message } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useChatText } from '../lib/use-chat-text';
import { useRooms } from '../hooks/useRooms';
import { roomTitle } from './RoomList';
import { Avatar, Icon } from './Visual';

const reasonKeys: Record<string, string> = {
  too_many_messages: 'chat.forwardErrorMessages', too_many_rooms: 'chat.forwardLimit',
  secret_source: 'chat.forwardErrorSecret', message_not_found: 'chat.forwardErrorMissing',
  message_deleted: 'chat.forwardErrorDeleted', system_message: 'chat.forwardErrorSystem',
  attachment_not_ready: 'chat.forwardErrorAttachment',
};

/** FR-MSG-011 / DEC-083: one intent and immutable targets across partial/network retries. */
export function ForwardDialog({ slug, message, returnFocus, onClose, onDone }: {
  slug: string; message: Message; returnFocus: HTMLButtonElement | null;
  onClose: () => void; onDone: (count: number) => void;
}) {
  const { text } = useChatText();
  const rooms = useRooms(slug);
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const [clientForwardId] = useState(() => crypto.randomUUID());
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<string[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');
  useEffect(() => {
    mounted.current = true;
    const dialog = dialogRef.current;
    dialog?.showModal();
    searchRef.current?.focus();
    return () => { mounted.current = false; dialog?.close(); returnFocus?.focus({ preventScroll: true }); };
  }, [returnFocus]);

  const shown = rooms.data?.filter(item => roomTitle(item).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) ?? [];
  const send = async () => {
    if (submitting.current || selected.length === 0) return;
    submitting.current = true;
    setBusy(true);
    setErrorKey('');
    const targets = submitted ?? selected;
    setSubmitted(targets);
    try {
      const response = await endpoints.forwardMessages(slug, { clientForwardId, sourceRoomId: message.room_id, messageIds: [message.id], roomIds: targets });
      void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
      if (!mounted.current) return;
      for (const result of response.results) void queryClient.invalidateQueries({ queryKey: ['messages', result.room_id] });
      setFailed(response.failed_room_ids);
      if (response.failed_room_ids.length === 0) { onDone(targets.length); onClose(); }
    } catch (error) {
      if (!mounted.current) return;
      let key = 'chat.forwardError';
      if (error instanceof ApiError) {
        if (error.status >= 400 && error.status < 500) {
          // Validation/access errors let the user correct the targets. Keep
          // clientForwardId: each source/target pair is independently idempotent.
          setSubmitted(null);
          setFailed([]);
        }
        if (error.status === 404) key = 'chat.forwardErrorRooms';
        else if (error.status === 403) key = 'chat.forwardErrorMember';
        else if (error.status === 429) key = 'chat.forwardErrorRate';
        else if (error.code === 'MSG_FORWARD_INVALID') key = reasonKeys[String(error.details?.reason)] ?? key;
      }
      setErrorKey(key);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return createPortal(
    <dialog ref={dialogRef} className="bc-message-menu bc-forward-dialog" data-testid="forward-dialog" aria-labelledby="forward-title" onCancel={onClose}>
      <div className="bc-message-menu-heading"><strong id="forward-title">{text('chat.forwardTitle')}</strong><button className="bc-chat-control" aria-label={text('chat.cancel')} onClick={onClose}><Icon name="close" size={18} /></button></div>
      <p className="bc-forward-preview">{message.body || message.attachments.map(attachment => attachment.original_name).join(', ')}</p>
      <label className="bc-chat-search"><Icon name="search" size={18} /><input ref={searchRef} type="search" aria-label={text('chat.forwardSearch')} placeholder={text('chat.forwardSearch')} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <p className="bc-forward-hint" role="status"><span>{text('chat.forwardLimit')}</span><span> · {selected.length}/10</span></p>
      {rooms.isLoading && <p className="bc-forward-hint" role="status">{text('chat.loading')}</p>}
      {rooms.isError && <div className="bc-forward-hint"><p role="alert">{text('chat.forwardError')}</p><button onClick={() => void rooms.refetch()}>{text('chat.retry')}</button></div>}
      <div className="bc-forward-rooms" role="group" aria-label={text('chat.forwardTitle')}>
        {shown.map(item => {
          const checked = selected.includes(item.room.id);
          const didFail = failed.includes(item.room.id);
          return <label className="bc-forward-room" key={item.room.id} data-failed={didFail}>
            <input type="checkbox" checked={checked} disabled={submitted !== null || (!checked && selected.length >= 10)} onChange={() => setSelected(current => checked ? current.filter(id => id !== item.room.id) : current.length < 10 ? [...current, item.room.id] : current)} />
            <Avatar name={roomTitle(item)} />
            <span className="bc-forward-room-name">{item.room.is_secret && <span aria-label={text('room.secret.label')}>🔒 </span>}{roomTitle(item)}{didFail && <small>{text('chat.forwardFailed')}</small>}</span>
          </label>;
        })}
        {!rooms.isLoading && !rooms.isError && shown.length === 0 && <p className="bc-forward-hint">{text('chat.noResults')}</p>}
      </div>
      {failed.length > 0 && <p className="bc-forward-hint bc-forward-error" role="alert">{text('chat.forwardPartial').replace('{count}', String(failed.length))}</p>}
      {errorKey && <p className="bc-forward-hint bc-forward-error" role="alert">{text(errorKey)}</p>}
      <button className="bc-forward-submit" disabled={busy || selected.length === 0} onClick={() => void send()}>{busy ? text('chat.sending') : submitted ? text('chat.forwardRetry') : text('chat.forwardConfirm').replace('{count}', String(selected.length))}</button>
    </dialog>, document.body,
  );
}
