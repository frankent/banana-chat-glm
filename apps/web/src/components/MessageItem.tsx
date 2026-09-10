import { useEffect, useRef, useState } from 'react';
import { MediaViewer } from './MediaViewer';
import { Markdown } from './ai/Markdown';
import { Avatar } from './Visual';
import type { Attachment, Message } from '@banana-chat/shared';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
export function AttachmentView({ attachment }: { attachment: Attachment }) {
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
  /** sender may edit+delete; room owner/admin may delete as moderator (FR-MSG-005/006) */
  canModerate?: boolean;
  onReply?: (message: Message) => void;
  onPin?: (message: Message) => void;
  onJump?: (seq: number) => void;
  onEdit?: (messageId: string, body: string) => Promise<unknown>;
  onDelete?: (messageId: string) => Promise<unknown>;
}

export function MessageItem({ message, mine, canModerate = false, grouped = false, onEdit, onDelete, onReply, onPin, onJump }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (message.type === 'system') {
    return (
      <div className="my-2 text-center" data-testid="message" data-system="true">
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{systemText(message)}</span>
      </div>
    );
  }

  const pending = message.id.startsWith('optimistic-');
  const deleted = message.deleted_at !== null;
  const mayEdit = mine && !deleted && !pending && onEdit !== undefined;
  const mayDelete = !pending && !deleted && (mayEdit || (canModerate && onDelete !== undefined));

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
      {!mine && <Avatar name={message.sender?.display_name ?? 'Member'} className="bc-message-avatar" />}
      <div className={`bc-message-bubble relative max-w-[70%] rounded-2xl px-3 py-1.5 ${mine ? 'bg-yellow-300' : 'bg-white'} ${pending ? 'opacity-60' : ''} shadow-sm`}>
        {!mine && message.sender !== null && (
          <p className="text-xs font-semibold text-slate-600">{message.sender.display_name}</p>
        )}
        {!deleted && message.reply_to && <button className="bc-reply-quote" onClick={() => message.reply_to?.seq && onJump?.(message.reply_to.seq)}><strong>Reply</strong><span>{message.reply_to.deleted ? 'Deleted message' : message.reply_to.snippet}</span></button>}
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
        <p className="mt-0.5 text-right text-[10px] text-slate-500">
          {pending ? 'sending…' : formatTime(message.created_at)}
          {!deleted && message.edit_count > 0 && <span className="ml-1 italic" data-testid="edited-flag">(แก้ไขแล้ว)</span>}
        </p>

        {/* hover actions — edit (sender), delete (sender or moderator) */}
        {!pending && !editing && !deleted && (mayEdit || mayDelete || onReply || onPin) && (
          <div
            className={`absolute top-0 ${mine ? '-left-16' : '-right-16'} hidden gap-1 group-hover:flex`}
            data-testid="message-actions"
          >
            {onReply && <button aria-label="Reply" title="Reply" onClick={() => onReply(message)}>↩</button>}
            {onPin && <button aria-label="Pin message" title="Pin message" onClick={() => onPin(message)}>⌖</button>}
            {mayEdit && (
              <button
                type="button"
                title="แก้ไข"
                className="rounded-full bg-white px-2 py-0.5 text-xs shadow hover:bg-slate-100"
                onClick={() => {
                  setDraft(message.body ?? '');
                  setError(null);
                  setEditing(true);
                }}
                data-testid="edit-button"
              >
                ✏️
              </button>
            )}
            {mayDelete && (
              <button
                type="button"
                title="ลบ"
                disabled={busy}
                className="rounded-full bg-white px-2 py-0.5 text-xs shadow hover:bg-red-50 disabled:opacity-40"
                onClick={() => void confirmDelete()}
                data-testid="delete-button"
              >
                🗑️
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
