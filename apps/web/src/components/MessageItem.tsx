import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatText } from '../lib/use-chat-text';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';
import { MediaViewer } from './MediaViewer';
import { Markdown } from './ai/Markdown';
import { Avatar, Icon } from './Visual';
import { CallStartedCard } from './calls/CallStartedCard';
import { MessageLinkCard, hiddenBodyRef, messageCardInfo } from './links/MessageLinkCard';
import { REACTION_PRESETS, type Attachment, type Message, type ReactionCount, type ReactionUsers } from '@banana-chat/shared';
import { ApiError } from '@banana-chat/api-client';
import { reactToMessage, sortReactions, type MessageStore } from '@banana-chat/chat-core';
import { reactionsText } from '../lib/reactions-text';

const ReactionPicker = lazy(() => import('./ReactionPicker').then(module => ({ default: module.ReactionPicker })));

function formatTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function deletedMessage(message: Message) { return message.deleted_at !== null; }
function pendingMessage(message: Message) { return message.id.startsWith('optimistic-'); }

function systemText(message: Message): string {
  const event = message.system_event?.event ?? 'system';
  const actor = message.sender?.display_name ?? 'Someone';
  switch (event) {
    case 'room.created':
      return `${actor} created the room`;
    case 'room.renamed': // legacy spelling
    case 'room_renamed':
      return `${actor} renamed the room to ${String(message.system_event?.name ?? '')}`;
    // FR-PROF-008 — context is empty by design (no signed URLs in messages)
    case 'room_avatar_changed':
      return `${actor} changed the group photo`;
    case 'member_added': {
      // DEC-097 — "{actor} added {name, name, ...}"; the actor is left out of the
      // list (group creation lists the creator too). Older rows carry only ids.
      const members = Array.isArray(message.system_event?.members) ? (message.system_event.members as Array<{ id?: string; display_name?: string }>) : [];
      const names = members.filter(m => m.id !== message.sender_id).map(m => m.display_name).filter((n): n is string => !!n);
      if (names.length > 0) return `${actor} added ${names.join(', ')}`;
      const ids = Array.isArray(message.system_event?.user_ids) ? (message.system_event.user_ids as string[]).filter(id => id !== message.sender_id) : [];
      if (ids.length > 1) return `${actor} added ${ids.length} members`;
      return `${actor} added ${String(message.system_event?.username ?? 'a member')}`;
    }
    case 'member_removed':
      return `${actor} removed ${String(message.system_event?.username ?? 'a member')}`;
    case 'member_left':
      return `${actor} left`;
    default:
      return `${actor} · ${event}`;
  }
}

function formatReactionCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(count);
}

function useReactionLongPress(onLongPress: () => void, onTap: () => void) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  return {
    onTouchStart: (event: React.TouchEvent) => {
      clear(); fired.current = false;
      const touch = event.touches[0]; if (!touch) return;
      origin.current = { x: touch.clientX, y: touch.clientY };
      timer.current = window.setTimeout(() => { fired.current = true; onLongPress(); }, 550);
    },
    onTouchMove: (event: React.TouchEvent) => {
      const touch = event.touches[0]; const start = origin.current;
      if (touch && start && (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10)) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onClick: (event: React.MouseEvent) => { if (fired.current) { event.preventDefault(); event.stopPropagation(); fired.current = false; } else onTap(); },
  };
}

function ReactorsDialog({ initialEmoji, copy, loadUsers, onClose }: {
  initialEmoji: string | null; copy: typeof reactionsText[keyof typeof reactionsText]; loadUsers: () => Promise<ReactionUsers>;
  onClose: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reactions, setReactions] = useState<ReactionUsers['reactions']>([]);
  const [active, setActive] = useState<string>('all');
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const tabbables = 'button:not([disabled]):not([tabindex="-1"]), [role="tabpanel"]';
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const loadRef = useRef(loadUsers); loadRef.current = loadUsers;
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  const receiveUsers = (data: ReactionUsers) => {
    setReactions(data.reactions);
    setActive(initialEmoji && data.reactions.some(item => item.emoji === initialEmoji) ? initialEmoji : 'all');
    setState('ready');
  };
  useEffect(() => {
    let active = true;
    void loadRef.current().then(data => { if (active) receiveUsers(data); }).catch(() => { if (active) setState('error'); });
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeHandler.current(); return; }
    };
    document.addEventListener('keydown', key);
    return () => { active = false; document.removeEventListener('keydown', key); };
  }, []);
  const activeItem = reactions.find(item => item.emoji === active);
  const allUsers = [...new Map(reactions.flatMap(item => item.users ?? []).map(user => [user.id, user])).values()];
  const users = active === 'all' ? allUsers : activeItem?.users ?? [];
  const selectTab = (key: string) => { setActive(key); tabRefs.current.get(key)?.focus(); };
  return <div className="bc-emoji-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className="bc-reactors" role="dialog" aria-modal="true" aria-label={copy.reactorsTitle} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(tabbables) ?? [])];
    if (!items.length) return;
    const first = items[0]!; const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <header><strong>{copy.reactorsTitle}</strong><button ref={closeRef} type="button" aria-label={copy.close} onClick={onClose}>×</button></header>
    {state === 'ready' && <div className="bc-reactor-tabs" role="tablist" aria-label={copy.reactorsTitle}>
      <button ref={node => { if (node) tabRefs.current.set('all', node); }} type="button" role="tab" id="bc-reactor-tab-all" aria-controls="bc-reactor-panel" aria-selected={active === 'all'} tabIndex={active === 'all' ? 0 : -1} onClick={() => setActive('all')} onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const keys = ['all', ...reactions.map(item => item.emoji)]; const index = keys.indexOf(active);
        selectTab(event.key === 'Home' ? keys[0]! : event.key === 'End' ? keys[keys.length - 1]! : keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length]!);
      }}>{copy.all}</button>
      {reactions.map(item => <button ref={node => { if (node) tabRefs.current.set(item.emoji, node); }} key={item.emoji} type="button" role="tab" id={`bc-reactor-tab-${encodeURIComponent(item.emoji)}`} aria-controls="bc-reactor-panel" aria-selected={active === item.emoji} tabIndex={active === item.emoji ? 0 : -1} aria-label={(item.count === 1 ? copy.reactorTabOne : copy.reactorTabMany).replace('{emoji}', item.emoji).replace('{count}', String(item.count))} onClick={() => setActive(item.emoji)} onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const keys = ['all', ...reactions.map(reaction => reaction.emoji)]; const index = keys.indexOf(active);
        selectTab(event.key === 'Home' ? keys[0]! : event.key === 'End' ? keys[keys.length - 1]! : keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length]!);
      }}>{item.emoji} {item.count}</button>)}
    </div>}
    {state === 'loading' ? <p role="status">{copy.loading}</p> : state === 'error' ? <div><p role="alert">{copy.failed}</p><button onClick={() => { setState('loading'); void loadRef.current().then(receiveUsers).catch(() => setState('error')); }}>{copy.retry}</button></div> : <div id="bc-reactor-panel" role="tabpanel" aria-labelledby={active === 'all' ? 'bc-reactor-tab-all' : `bc-reactor-tab-${encodeURIComponent(active)}`} tabIndex={0}>{users.length === 0 ? <p>{copy.noUsers}</p> : <ul>{users.map(person => <li key={person.id}><Avatar name={person.display_name} avatar={person.avatar} /><span>{person.display_name}</span></li>)}</ul>}</div>}
  </section></div>;
}

function ReactionChip({ item, own, copy, testId, onChoose, onPeople }: {
  item: { emoji: string; count: number }; own: boolean; copy: typeof reactionsText[keyof typeof reactionsText]; testId: string;
  onChoose: () => void; onPeople: (trigger?: HTMLElement) => void;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const openPeople = () => onPeople(chipRef.current ?? undefined);
  const longPress = useReactionLongPress(openPeople, onChoose);
  const label = (own ? copy.chipOwnLabel : copy.chipLabel).replace('{emoji}', item.emoji).replace('{count}', formatReactionCount(item.count)).replace('{reactionWord}', item.count === 1 ? 'reaction' : 'reactions');
  return <button ref={chipRef} type="button" className="bc-reaction-chip" aria-pressed={own} aria-label={label} data-testid={testId}
    onContextMenu={event => { event.preventDefault(); openPeople(); }} onKeyDown={event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openPeople(); }
    }} {...longPress}>
    <span className="bc-reaction-chip-wrap"><span>{item.emoji}</span><span>{formatReactionCount(item.count)}</span></span>
  </button>;
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
  secretActive?: boolean;
  onForward?: (message: Message, trigger: HTMLButtonElement | null) => void;
  /** sender may edit+delete; room owner/admin may delete as moderator (FR-MSG-005/006) */
  canModerate?: boolean;
  onReply?: (message: Message) => void;
  onPin?: (message: Message) => void;
  onJump?: (seq: number) => void;
  onEdit?: (messageId: string, body: string) => Promise<unknown>;
  onDelete?: (messageId: string) => Promise<unknown>;
  reactionStore?: MessageStore;
  reactionApi?: {
    set: (emoji: string) => Promise<{ message_id: string; reactions: NonNullable<Message['reactions']>; my_reaction: string | null }>;
    clear: () => Promise<{ message_id: string; reactions: NonNullable<Message['reactions']>; my_reaction: string | null }>;
    users: () => Promise<ReactionUsers>;
    counts?: () => Promise<ReactionCount[]>;
  };
}

export function MessageItem({ message, mine, canModerate = false, grouped = false, showSender = true, replySender, secretActive = false, onForward, onEdit, onDelete, onReply, onPin, onJump, reactionStore, reactionApi }: MessageItemProps) {
  const { text, locale } = useChatText();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDialogElement>(null);
  const actionsToggleRef = useRef<HTMLButtonElement>(null);
  const suppressActionsReturnFocus = useRef(false);
  const reactionTrigger = useRef<HTMLButtonElement>(null);
  const reactionOpenRef = useRef<HTMLButtonElement>(null);
  const peopleReturn = useRef<HTMLElement | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [reactionDialog, setReactionDialog] = useState<{ type: 'picker' } | { type: 'reactors'; emoji: string | null } | null>(null);
  const previousReactionDialog = useRef(reactionDialog);
  const [quickBelow, setQuickBelow] = useState(false);
  const [reactionNote, setReactionNote] = useState('');
  const pickerReturn = useRef<HTMLElement | null>(null);
  const reactionCopy = reactionsText[locale];
  const reactions = sortReactions(message.reactions ?? []);
  const mayReact = !deletedMessage(message) && message.type !== 'system' && !pendingMessage(message) && !!reactionStore && !!reactionApi;
  useEffect(() => {
    if (!quickOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!bubbleRef.current?.contains(event.target as Node) && !quickRef.current?.contains(event.target as Node)) setQuickOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuickOpen(false);
        reactionOpenRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [quickOpen]);

  useLayoutEffect(() => {
    if (!quickOpen) return;
    const bubble = bubbleRef.current;
    const list = bubble?.closest('.bc-message-list');
    if (!bubble || !list) return;
    const row = bubble.closest('[data-seq]');
    const place = () => {
      const bubbleBox = bubble.getBoundingClientRect(); const listBox = list.getBoundingClientRect();
      const previous = row?.previousElementSibling?.querySelector<HTMLElement>('.bc-message-bubble')?.getBoundingClientRect();
      const next = row?.nextElementSibling?.querySelector<HTMLElement>('.bc-message-bubble')?.getBoundingClientRect();
      const above = bubbleBox.top - Math.max(listBox.top, previous?.bottom ?? listBox.top);
      const below = Math.min(listBox.bottom, next?.top ?? listBox.bottom) - bubbleBox.bottom;
      const fitsAbove = above >= 48; const fitsBelow = below >= 48;
      const narrowFinePointer = window.innerWidth <= 480 && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      setQuickBelow(!narrowFinePointer && !fitsAbove && (fitsBelow || below > above));
    };
    place();
    window.addEventListener('resize', place);
    list.addEventListener('scroll', place);
    return () => { window.removeEventListener('resize', place); list.removeEventListener('scroll', place); };
  }, [quickOpen]);

  useLayoutEffect(() => {
    if (previousReactionDialog.current && !reactionDialog) {
      const target = previousReactionDialog.current.type === 'picker' ? pickerReturn.current : peopleReturn.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else bubbleRef.current?.focus({ preventScroll: true });
    }
    previousReactionDialog.current = reactionDialog;
  }, [reactionDialog]);
  function showPicker(trigger: HTMLElement | null) { pickerReturn.current = trigger; setQuickOpen(false); setReactionDialog({ type: 'picker' }); }
  function toggleQuick() { setQuickOpen(value => !value); }
  async function chooseReaction(emoji: string) {
    if (!reactionStore || !reactionApi) return;
    setQuickOpen(false);
    setReactionDialog(null);
    setReactionNote('');
    try {
      await reactToMessage(reactionStore, message.id, emoji, reactionApi);
    } catch (error) {
      setReactionNote(error instanceof ApiError && error.code === 'REACTION_LIMIT' ? reactionCopy.limit : reactionCopy.reactionFailed);
    }
  }
  const openPeople = (emoji: string | null, trigger?: HTMLElement) => { peopleReturn.current = trigger ?? document.activeElement as HTMLElement | null; setReactionDialog({ type: 'reactors', emoji }); };

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
    return () => { if (dialog.open) dialog.close(); if (!suppressActionsReturnFocus.current) trigger?.focus({ preventScroll: true }); suppressActionsReturnFocus.current = false; };
  }, [actionsOpen]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (message.type === 'system' && message.system_event?.event === 'call_started' && !message.deleted_at) {
    return <CallStartedCard message={message} />;
  }

  if (message.type === 'system') {
    return (
      <div className="bc-system-message my-2 text-center" data-testid="message" data-system="true">
        <span className="rounded-full bg-slate-200 px-3 py-1 text-xs text-slate-600">{systemText(message)}</span>
      </div>
    );
  }

  const pending = message.id.startsWith('optimistic-');
  const deleted = message.deleted_at !== null;
  const linkCard = deleted || pending ? { card: null, hideBody: false } : messageCardInfo(message.body);
  const mayEdit = mine && !message.forwarded_from && !deleted && !pending && onEdit !== undefined;
  const mayDelete = !pending && !deleted && (mine || canModerate) && onDelete !== undefined;
  const mayForward = !pending && !deleted && !secretActive && onForward !== undefined;
  const compactText = !deleted && !editing && message.attachments.length === 0 && message.body !== null && message.body.trim().length > 0 && message.body.length <= 60 && !/[\n`#*|]/.test(message.body);
  const hasActions = !pending && !editing && !deleted && Boolean(mayEdit || mayDelete || mayForward || onReply || onPin || mayReact);

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
      {!mine && showSender && <Avatar name={message.sender?.display_name ?? 'Member'} avatar={message.sender?.avatar} className="bc-message-avatar" />}
      <div ref={bubbleRef} tabIndex={-1} data-compact={compactText} className={`bc-message-bubble ${pending ? 'is-pending' : ''}`}>
        {mayReact && <button ref={reactionOpenRef} type="button" className="bc-reaction-open" aria-label={reactionCopy.react} title={reactionCopy.react} onClick={toggleQuick}>☺</button>}
        {!mine && showSender && message.sender !== null && (
          <p className="text-xs font-semibold text-slate-600">{message.sender.display_name}</p>
        )}
        {!deleted && message.forwarded_from && <p className="bc-forwarded-header" data-testid="forwarded-header"><span aria-hidden="true">↪ </span>{message.forwarded_from.display_name ? text('message.forwardedFrom').replace('{name}', message.forwarded_from.display_name) : text('message.forwardedUnknown')}</p>}
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
            {message.body !== null && <div ref={linkCard.hideBody ? hiddenBodyRef : undefined} className={linkCard.hideBody ? 'bc-markdown bc-link-body-hidden' : 'bc-markdown'}><Markdown content={message.body} /></div>}
            {linkCard.card !== null && <MessageLinkCard card={linkCard.card} />}
          </>
        )}
        {mayReact && reactions.length > 0 && <div className="bc-reaction-area" data-testid={`reaction-area-${message.id}`}>
          {reactions.length > 0 && <div className="bc-reaction-chips" role="group" aria-label={reactionCopy.react}>
            {reactions.map(item => <ReactionChip key={item.emoji} item={item} own={message.my_reaction === item.emoji} copy={reactionCopy} testId={`reaction-chip-${item.emoji}`} onChoose={() => void chooseReaction(item.emoji)} onPeople={trigger => openPeople(item.emoji, trigger)} />)}
          </div>}
        </div>}
        {reactionNote && <p className="bc-reaction-note" role="status">{reactionNote}</p>}
        <div className="bc-message-footer">
        <p>
          {pending ? text('chat.sending') : formatTime(message.created_at, locale)}
          {!deleted && message.edit_count > 0 && <span className="ml-1 italic" data-testid="edited-flag">({text('message.edited')})</span>}
        </p>
        </div>
        {error && !editing && <p role="alert" className="bc-message-error">{error}</p>}
        {hasActions && <button ref={actionsToggleRef} type="button" className="bc-message-actions-toggle" aria-label={text('chat.actions')} aria-haspopup="dialog" aria-expanded={actionsOpen} onClick={() => { setDeleteConfirm(false); setActionsOpen(true); }}><Icon name="more" size={18} /></button>}
        {mayReact && quickOpen && <div ref={quickRef} className={`bc-quick-reactions ${quickBelow ? 'is-below' : ''}`} role="group" aria-label={reactionCopy.react}>
          {REACTION_PRESETS.map(emoji => <button type="button" key={emoji} aria-label={reactionCopy.selected.replace('{emoji}', emoji)} aria-pressed={message.my_reaction === emoji} onClick={() => void chooseReaction(emoji)}>{emoji}</button>)}
          <button type="button" aria-label={reactionCopy.picker} ref={reactionTrigger} onClick={() => showPicker(reactionOpenRef.current)}>＋</button>
        </div>}
      </div>
        {hasActions && actionsOpen && createPortal(
          <dialog ref={actionsRef} className="bc-message-menu" data-testid="message-actions" data-open="true"
            aria-label={text(deleteConfirm ? 'chat.deleteConfirm' : 'chat.actions')}
            onCancel={() => setActionsOpen(false)}
            onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setActionsOpen(false); } }}>
            <div className="bc-message-menu-heading"><strong>{text(deleteConfirm ? 'chat.deleteConfirm' : 'chat.actions')}</strong><button autoFocus className="bc-chat-control" aria-label={text('chat.cancel')} onClick={() => setActionsOpen(false)}><Icon name="close" size={18} /></button></div>
            {deleteConfirm ? <><p className="bc-delete-hint">{text('chat.deleteHint')}</p><button className="is-destructive" disabled={busy} onClick={async () => { await confirmDelete(); setActionsOpen(false); }}><Icon name="trash" size={18} />{text('message.delete')}</button><button onClick={() => setActionsOpen(false)}>{text('chat.cancel')}</button></> : <>
              {mayReact && <div className="bc-menu-reaction-row" role="group" aria-label={reactionCopy.react}>
                {REACTION_PRESETS.map(emoji => <button type="button" key={emoji} aria-label={reactionCopy.selected.replace('{emoji}', emoji)} aria-pressed={message.my_reaction === emoji} onClick={() => { setActionsOpen(false); void chooseReaction(emoji); }}>{emoji}</button>)}
                <button type="button" aria-label={reactionCopy.picker} onClick={() => { pickerReturn.current = actionsToggleRef.current; suppressActionsReturnFocus.current = true; actionsRef.current?.close(); setActionsOpen(false); setReactionDialog({ type: 'picker' }); }}>＋</button>
              </div>}
              {mayReact && reactions.length > 0 && <button aria-label={reactionCopy.whoReacted} onClick={() => { peopleReturn.current = actionsToggleRef.current; suppressActionsReturnFocus.current = true; actionsRef.current?.close(); setReactionDialog({ type: 'reactors', emoji: null }); setActionsOpen(false); }}><Icon name="users" size={18} />{reactionCopy.whoReacted}</button>}
              {onReply && <button aria-label="Reply" onClick={() => {setActionsOpen(false);onReply(message);}}><Icon name="reply" size={18} />{text('message.reply')}</button>}
              {onPin && <button aria-label="Pin message" onClick={() => {setActionsOpen(false);onPin(message);}}><Icon name="pin" size={18} />{text('chat.pin')}</button>}
              {mayForward && <button onClick={() => { setActionsOpen(false); onForward?.(message, actionsToggleRef.current); }}><Icon name="arrow" size={18} />{text('message.forward')}</button>}
              {mayEdit && <button aria-label="Edit message" data-testid="edit-button" onClick={() => {setActionsOpen(false);setDraft(message.body ?? '');setError(null);setEditing(true);}}><Icon name="edit" size={18} />{text('message.edit')}</button>}
              {mayDelete && <button className="is-destructive" aria-label="Delete message" data-testid="delete-button" onClick={() => setDeleteConfirm(true)}><Icon name="trash" size={18} />{text('message.delete')}</button>}
            </>}
          </dialog>, document.body
        )}
        {reactionDialog?.type === 'picker' && createPortal(<Suspense fallback={<div className="bc-emoji-picker bc-reaction-picker-fallback" aria-hidden="true" />}><ReactionPicker copy={reactionCopy} onChoose={emoji => void chooseReaction(emoji)} onClose={() => setReactionDialog(null)} /></Suspense>, document.body)}
        {reactionDialog?.type === 'reactors' && reactionApi && createPortal(<ReactorsDialog initialEmoji={reactionDialog.emoji} copy={reactionCopy} loadUsers={reactionApi.users} onClose={() => setReactionDialog(null)} />, document.body)}
    </div>
  );
}
