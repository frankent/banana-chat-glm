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
function AttachmentView({ attachment }: { attachment: Attachment }) {
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
      <a href={attachment.urls.original ?? thumb} target="_blank" rel="noreferrer">
        <img
          src={thumb}
          alt={attachment.original_name}
          data-testid="attachment-image"
          className="max-h-72 max-w-full rounded-lg object-contain"
        />
      </a>
    );
  }

  if (attachment.kind === 'video' && attachment.urls.original !== null) {
    return (
      <video
        controls
        preload="metadata"
        src={attachment.urls.original}
        poster={attachment.urls.poster ?? undefined}
        data-testid="attachment-video"
        className="max-h-72 max-w-full rounded-lg"
      />
    );
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

export function MessageItem({ message, mine }: { message: Message; mine: boolean }) {
  if (message.type === 'system') {
    return (
      <div className="my-2 text-center" data-testid="message" data-system="true">
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{systemText(message)}</span>
      </div>
    );
  }

  const pending = message.id.startsWith('optimistic-');
  const deleted = message.deleted_at !== null;

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid="message" data-mine={mine}>
      <div className={`max-w-[70%] rounded-2xl px-3 py-1.5 ${mine ? 'bg-yellow-300' : 'bg-white'} ${pending ? 'opacity-60' : ''} shadow-sm`}>
        {!mine && message.sender !== null && (
          <p className="text-xs font-semibold text-slate-600">{message.sender.display_name}</p>
        )}
        {deleted ? (
          <p className="text-sm italic text-slate-400">This message was deleted</p>
        ) : (
          <>
            {message.attachments.length > 0 && (
              <div className="mb-1 flex flex-col gap-1">
                {message.attachments.map((a) => (
                  <AttachmentView key={a.id} attachment={a} />
                ))}
              </div>
            )}
            {message.body !== null && <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>}
          </>
        )}
        <p className="mt-0.5 text-right text-[10px] text-slate-500">
          {pending ? 'sending…' : formatTime(message.created_at)}
        </p>
      </div>
    </div>
  );
}
