import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatText } from '../lib/use-chat-text';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';
import { MediaViewer } from './MediaViewer';
import { Markdown } from './ai/Markdown';
import { Avatar, Icon } from './Visual';
import type { Attachment, Message } from '@banana-chat/shared';

function formatTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function systemText(message: Message): string {
  const event = message.system_event?.event ?? 'system';
  const actor = message.sender?.display_name ?? 'Someone';
  switch (event) {
    case 'room.created':
      return `${actor} created the room`;
    case 'room.renamed':
      return `${actor} renamed the room to ${String(message.system_event?.name ?? '')}`;
    case 'member_added':
      return `${actor} added ${String(message.system_event?.username ?? 'a member')}`;
    case 'member_removed':
      return `${actor} removed ${String(message.system_event?.username ?? 'a member')}`;
    case 'member_left':
      return `${actor} left`;
    default:
      return `${actor} · ${event}`;
  }
}

/** FR-MEDIA-004 — thumbnails inline, originals open in a new tab on click. */
export function AttachmentView({ attachment: initialAttachment }: { attachment: Attachment }) {
  const { me, currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug;
  const processing = (status: Attachment['status']) => ['pending', 'uploaded', 'processing'].includes(status);
  const refresh = processing(initialAttachment.status);
  // FR-MEDIA-004: sending clears the composer's upload polling. Both sender
  // and recipient must still resolve a processing attachment without reload,
  // including when its user-scoped attachment.ready event was missed.
  const statusQuery = useQuery({
    queryKey: ['attachment-status', me?.id, slug, initialAttachment.id],
    queryFn: () => endpoints.attachment(initialAttachment.id, slug!),
    enabled: refresh && !!slug && !!me,
    refetchInterval: query => query.state.error ? false : processing(query.state.data?.attachment.status ?? initialAttachment.status) ? 1500 : false,
  });
  const attachment = refresh ? statusQuery.data?.attachment ?? initialAttachment : initialAttachment;
  const [viewing, setViewing] = useState(false);
  const viewer = viewing ? <MediaViewer attachment={attachment} onClose={() => setViewing(false)} /> : null;
  const thumb = attachment.urls.thumb_md ?? attachment.urls.thumb_sm ?? attachment.urls.original;

  if (attachment.status === 'processing' || attachment.status === 'pending' || attachment.status === 'uploaded') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs text-slate-500" data-testid="attachment-processing">
        <span className="animate-pulse">⏳</span> {attachment.original_name}
      </div>
    );
  }

  if (attachment.status === 'failed') {
    return (
      <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="attachment-failed">
        ประมวลผล {attachment.original_name} ไม่สำเร็จ
      </div>
    );
  }

  if (attachment.kind === 'image' && thumb !== null) {
    return (
      <><button onClick={() => setViewing(true)} aria-label={`View ${attachment.original_name}`}>
        <img
          src={thumb}
          alt={attachment.original_name}
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          style={attachment.width && attachment.height ? { width: Math.min(attachment.width, 288 * attachment.width / attachment.height), height: 'auto', aspectRatio: `${attachment.width}/${attachment.height}` } : undefined}
          data-testid="attachment-image"
          className="max-h-72 max-w-full rounded-lg object-contain"
        />
      </button>{viewer}</>
    );
  }

  if (attachment.kind === 'video' && attachment.urls.original !== null) {
    return (
      <><video
        controls
        preload="metadata"
        src={attachment.urls.original}
        poster={attachment.urls.poster ?? undefined}
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
        style={attachment.width && attachment.height ? { width: Math.min(attachment.width, 288 * attachment.width / attachment.height), height: 'auto', aspectRatio: `${attachment.width}/${attachment.height}` } : undefined}
        data-testid="attachment-video"
        className="max-h-72 max-w-full rounded-lg"
      /><button onClick={() => setViewing(true)}>Open video viewer</button>{viewer}</>
    );
  }

  if (/^(text\/|application\/(json|xml))/.test(attachment.mime_type) || /\.(md|txt|json|csv|log)$/i.test(attachment.original_name)) {
    return <><button className="bc-file-preview" onClick={() => setViewing(true)} data-testid="attachment-file">📄 {attachment.original_name} · {formatSize(attachment.size_bytes)}</button>{viewer}</>;
  }
  return (
    <a
      href={attachment.urls.original ?? '#'}
      target="_blank"
      rel="noreferrer"
      data-testid="attachment-file"
      className="flex items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-xs hover:bg-black/10"
    >
      📎 <span className="max-w-56 truncate underline">{attachment.original_name}</span>
      <span className="text-slate-400">{formatSize(attachment.size_bytes)}</span>
    </a>
  );
}

export interface MessageItemProps {
  message: Message;
  mine: boolean;
  grouped?: boolean;
  showSender?: boolean;
  replySender?: string;
  /** sender may edit+delete; room owner/admin may delete as moderator (FR-MSG-005/006) */
  canModerate?: boolean;
  onReply?: (message: Message) => void;
  onPin?: (message: Message) => void;
  onJump?: (seq: number) => void;
  onEdit?: (messageId: string, body: string) => Promise<unknown>;
  onDelete?: (messageId: string) => Promise<unknown>;
}

export function MessageItem({ message, mine, canModerate = false, grouped = false, showSender = true, replySender, onEdit, onDelete, onReply, onPin, onJump }: MessageItemProps) {
  const { text, locale } = useChatText();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDialogElement>(null);
  const actionsToggleRef = useRef<HTMLButtonElement>(null);

  // A native modal dialog gives touch a sheet, desktop an anchored menu,
  // and both a focus trap. Closed actions do not occupy any bubble layout.
  useEffect(() => {
    const dialog = actionsRef.current;
    if (!actionsOpen || !dialog) return;
    const trigger = actionsToggleRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (rect) {
      dialog.style.setProperty('--menu-left', `${Math.max(12, Math.min(rect.right - 228, window.innerWidth - 240))}px`);
      dialog.style.setProperty('--menu-top', `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 310))}px`);
    }
    dialog.showModal();
    return () => { dialog.close(); trigger?.focus({ preventScroll: true }); };
  }, [actionsOpen]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (message.type === 'system') {
    return (
      <div className="bc-system-message my-2 text-center" data-testid="message" data-system="true">
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{systemText(message)}</span>
      </div>
    );
  }

  const pending = message.id.startsWith('optimistic-');
  const deleted = message.deleted_at !== null;
  const mayEdit = mine && !deleted && !pending && onEdit !== undefined;
  const mayDelete = !pending && !deleted && (mayEdit || (canModerate && onDelete !== undefined));
  const compactText = !deleted && !editing && message.attachments.length === 0 && message.body !== null && message.body.trim().length > 0 && message.body.length <= 60 && !/[\n`#*|]/.test(message.body);
  const hasActions = !pending && !editing && !deleted && Boolean(mayEdit || mayDelete || onReply || onPin);

  const submitEdit = async () => {
    const body = draft.trim();
    if (body === '' || onEdit === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await onEdit(message.id, body);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'แก้ไขไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (onDelete === undefined) return;
    setBusy(true);
    try {
      await onDelete(message.id);
    } catch {
      setError('ลบไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`bc-message group flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid="message" data-mine={mine} data-grouped={grouped}>
      {!mine && showSender && <Avatar name={message.sender?.display_name ?? 'Member'} className="bc-message-avatar" />}
      <div ref={bubbleRef} data-compact={compactText} className={`bc-message-bubble ${pending ? 'is-pending' : ''}`}>
        {!mine && showSender && message.sender !== null && (
          <p className="text-xs font-semibold text-slate-600">{message.sender.display_name}</p>
        )}
        {!deleted && message.reply_to && <button className="bc-reply-quote" onClick={() => message.reply_to?.seq && onJump?.(message.reply_to.seq)}><strong>{replySender ?? text('message.reply')}</strong><span>{message.reply_to.deleted ? 'Deleted message' : message.reply_to.snippet}</span></button>}
        {deleted ? (
          <p className="text-sm italic text-slate-400" data-testid="deleted-placeholder">
            {message.delete_reason === 'moderator' ? 'This message was removed by a moderator' : 'This message was deleted'}
          </p>
        ) : editing ? (
          <div className="flex flex-col gap-1 py-1" data-testid="edit-form">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit();
                }
                if (e.key === 'Escape') setEditing(false);
              }}
              rows={2}
              className="w-full resize-none rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm"
              data-testid="edit-input"
            />
            {error !== null && <p className="text-xs text-red-600" data-testid="edit-error">{error}</p>}
            <div className="flex justify-end gap-2 text-xs">
              <button type="button" onClick={() => setEditing(false)} className="px-2 py-0.5 text-slate-500 hover:underline">ยกเลิก</button>
              <button
                type="button"
                disabled={busy || draft.trim() === ''}
                onClick={() => void submitEdit()}
                className="rounded-full bg-slate-800 px-3 py-0.5 font-medium text-white disabled:opacity-40"
                data-testid="edit-save"
              >
                บันทึก
              </button>
            </div>
          </div>
        ) : (
          <>
            {message.attachments.length > 0 && (
              <div className="mb-1 flex flex-col gap-1">
                {message.attachments.map((a) => (
                  <AttachmentView key={a.id} attachment={a} />
                ))}
              </div>
            )}
            {message.body !== null && <div className="bc-markdown"><Markdown content={message.body} /></div>}
          </>
        )}
        <div className="bc-message-footer">
        <p>
          {pending ? text('chat.sending') : formatTime(message.created_at, locale)}
          {!deleted && message.edit_count > 0 && <span className="ml-1 italic" data-testid="edited-flag">({text('message.edited')})</span>}
        </p>
        </div>
        {error && !editing && <p role="alert" className="bc-message-error">{error}</p>}
        {hasActions && <button ref={actionsToggleRef} type="button" className="bc-message-actions-toggle" aria-label={text('chat.actions')} aria-haspopup="dialog" aria-expanded={actionsOpen} onClick={() => { setDeleteConfirm(false); setActionsOpen(true); }}><Icon name="more" size={18} /></button>}
        {hasActions && actionsOpen && createPortal(
          <dialog ref={actionsRef} className="bc-message-menu" data-testid="message-actions" data-open="true"
            aria-label={text(deleteConfirm ? 'chat.deleteConfirm' : 'chat.actions')}
            onCancel={() => setActionsOpen(false)}
            onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setActionsOpen(false); } }}>
            <div className="bc-message-menu-heading"><strong>{text(deleteConfirm ? 'chat.deleteConfirm' : 'chat.actions')}</strong><button autoFocus className="bc-chat-control" aria-label={text('chat.cancel')} onClick={() => setActionsOpen(false)}><Icon name="close" size={18} /></button></div>
            {deleteConfirm ? <><p className="bc-delete-hint">{text('chat.deleteHint')}</p><button className="is-destructive" disabled={busy} onClick={async () => { await confirmDelete(); setActionsOpen(false); }}><Icon name="trash" size={18} />{text('message.delete')}</button><button onClick={() => setActionsOpen(false)}>{text('chat.cancel')}</button></> : <>
              {onReply && <button aria-label="Reply" onClick={() => {setActionsOpen(false);onReply(message);}}><Icon name="reply" size={18} />{text('message.reply')}</button>}
              {onPin && <button aria-label="Pin message" onClick={() => {setActionsOpen(false);onPin(message);}}><Icon name="pin" size={18} />{text('chat.pin')}</button>}
              {mayEdit && <button aria-label="Edit message" data-testid="edit-button" onClick={() => {setActionsOpen(false);setDraft(message.body ?? '');setError(null);setEditing(true);}}><Icon name="edit" size={18} />{text('message.edit')}</button>}
              {mayDelete && <button className="is-destructive" aria-label="Delete message" data-testid="delete-button" onClick={() => setDeleteConfirm(true)}><Icon name="trash" size={18} />{text('message.delete')}</button>}
            </>}
          </dialog>, document.body
        )}
      </div>
    </div>
  );
}
